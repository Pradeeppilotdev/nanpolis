// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ExitGuard.sol";
import "../src/MockToken.sol";

contract ExitGuardTest is Test {
    ExitGuard g; MockToken t;
    address owner = address(0xA11CE); address guard = address(0xBEEF); address safe = address(0x5AFE);
    uint32 constant WINDOW = 3600;

    function setUp() public {
        g = new ExitGuard(); t = new MockToken("Test", "TST");
        t.mint(owner, 1000 ether);
        vm.startPrank(owner);
        t.approve(address(g), type(uint256).max);
        g.deposit(address(t), 1000 ether);
        g.setPolicy(address(t), guard, safe, 50_000, WINDOW, 5000, 600);
        vm.stopPrank();
    }

    function test_protectMovesBpsToSafe() public {
        vm.prank(guard);
        g.protect(owner, address(t), 5000, 75_000, WINDOW, keccak256("nansen"));
        assertEq(t.balanceOf(safe), 500 ether);
        assertEq(g.deposits(owner, address(t)), 500 ether);
    }

    function test_onlyGuard() public {
        vm.expectRevert(ExitGuard.NotGuard.selector);
        g.protect(owner, address(t), 1000, 75_000, WINDOW, bytes32(0));
    }

    function test_belowThresholdReverts() public {
        vm.prank(guard);
        vm.expectRevert(ExitGuard.BelowThreshold.selector);
        g.protect(owner, address(t), 1000, 10_000, WINDOW, bytes32(0));
    }

    function test_bpsCapReverts() public {
        vm.prank(guard);
        vm.expectRevert(ExitGuard.BpsTooHigh.selector);
        g.protect(owner, address(t), 6000, 75_000, WINDOW, bytes32(0));
    }

    function test_windowMismatchReverts() public {
        vm.prank(guard);
        vm.expectRevert(ExitGuard.WindowMismatch.selector);
        g.protect(owner, address(t), 1000, 75_000, 60, bytes32(0));
    }

    function test_cooldown() public {
        vm.startPrank(guard);
        g.protect(owner, address(t), 1000, 75_000, WINDOW, bytes32(0));
        vm.expectRevert(ExitGuard.Cooldown.selector);
        g.protect(owner, address(t), 1000, 75_000, WINDOW, bytes32(0));
        vm.warp(block.timestamp + 601);
        g.protect(owner, address(t), 1000, 75_000, WINDOW, bytes32(0));
        vm.stopPrank();
    }

    function test_revokeBlocksGuard() public {
        vm.prank(owner); g.revokeGuard(address(t));
        vm.prank(guard);
        vm.expectRevert(ExitGuard.NotGuard.selector);
        g.protect(owner, address(t), 1000, 75_000, WINDOW, bytes32(0));
    }

    function test_ownerCanWithdraw() public {
        vm.prank(owner); g.withdraw(address(t), 400 ether);
        assertEq(t.balanceOf(owner), 400 ether);
    }

    function test_rejectsNonContractToken() public {
        vm.expectRevert(ExitGuard.UnsupportedToken.selector);
        g.deposit(address(0x1234), 1);
    }

    function test_rejectsZeroDeposit() public {
        vm.expectRevert(ExitGuard.NothingToMove.selector);
        g.deposit(address(t), 0);
    }

    function test_rejectsTaxedDepositWithoutCrediting() public {
        OddToken odd = new OddToken();
        odd.configure(true, false, false);
        vm.expectRevert(ExitGuard.UnsupportedToken.selector);
        g.deposit(address(odd), 100);
        assertEq(g.deposits(address(this), address(odd)), 0);
        assertEq(odd.balanceOf(address(g)), 0);
    }

    function test_failedTransferRollsBackAccounting() public {
        OddToken odd = new OddToken();
        g.deposit(address(odd), 100);
        odd.configure(false, true, false);
        vm.expectRevert(ExitGuard.TransferFailed.selector);
        g.withdraw(address(odd), 100);
        assertEq(g.deposits(address(this), address(odd)), 100);
    }

    function test_transferCallbackCannotReenter() public {
        OddToken odd = new OddToken();
        odd.configure(false, false, true);
        g.deposit(address(odd), 100);
        assertFalse(odd.callbackSucceeded());
        assertEq(g.deposits(address(this), address(odd)), 100);
    }

    function test_policyUpdatePreservesCooldown() public {
        vm.prank(guard);
        g.protect(owner, address(t), 1000, 75_000, WINDOW, bytes32(0));
        vm.prank(owner);
        g.setPolicy(address(t), guard, safe, 50_000, WINDOW, 5000, 600);
        vm.prank(guard);
        vm.expectRevert(ExitGuard.Cooldown.selector);
        g.protect(owner, address(t), 1000, 75_000, WINDOW, bytes32(0));
    }

    function test_cooldownExactBoundary() public {
        vm.prank(guard);
        g.protect(owner, address(t), 1000, 75_000, WINDOW, bytes32(0));
        vm.warp(block.timestamp + 600);
        vm.prank(guard);
        g.protect(owner, address(t), 1000, 75_000, WINDOW, bytes32(0));
        assertEq(g.deposits(owner, address(t)), 810 ether);
    }

    function test_ownerIsolation() public {
        vm.expectRevert(ExitGuard.InsufficientDeposit.selector);
        g.withdraw(address(t), 1);
        assertEq(g.deposits(owner, address(t)), 1000 ether);
    }

    function test_protectionHandlesMaximumBalanceWithoutOverflow() public {
        MockToken huge = new MockToken("Huge", "HUGE");
        huge.mint(address(this), type(uint256).max);
        huge.approve(address(g), type(uint256).max);
        g.deposit(address(huge), type(uint256).max);
        g.setPolicy(address(huge), address(this), safe, 1, WINDOW, 10_000, 1);
        g.protect(address(this), address(huge), 10_000, 1, WINDOW, bytes32(0));
        assertEq(huge.balanceOf(safe), type(uint256).max);
        assertEq(g.deposits(address(this), address(huge)), 0);
    }

    function test_failedProtectionRollsBackCooldownAndBalance() public {
        OddToken odd = new OddToken();
        g.deposit(address(odd), 100);
        g.setPolicy(address(odd), address(this), safe, 1, WINDOW, 10_000, 600);
        odd.configure(false, true, false);
        vm.expectRevert(ExitGuard.TransferFailed.selector);
        g.protect(address(this), address(odd), 5000, 1, WINDOW, bytes32(0));
        assertEq(g.deposits(address(this), address(odd)), 100);
        odd.configure(false, false, false);
        g.protect(address(this), address(odd), 5000, 1, WINDOW, bytes32(0));
        assertEq(odd.balanceOf(safe), 50);
    }

    function testFuzz_protectionConservesPosition(uint16 bps) public {
        bps = uint16(bound(bps, 1, 5000));
        vm.prank(guard);
        g.protect(owner, address(t), bps, 50_000, WINDOW, bytes32(0));
        assertEq(t.balanceOf(safe) + g.deposits(owner, address(t)), 1000 ether);
        assertEq(t.balanceOf(address(g)), g.deposits(owner, address(t)));
    }
}

/// @dev Models inbound tax, false transfer return and a malicious token callback.
contract OddToken {
    mapping(address => uint256) public balanceOf;
    bool public taxed;
    bool public fail;
    bool public callback;
    bool public callbackSucceeded;

    function configure(bool tax_, bool fail_, bool callback_) external {
        taxed = tax_; fail = fail_; callback = callback_;
    }

    function transferFrom(address, address to, uint256 amount) external returns (bool) {
        if (callback) {
            (callbackSucceeded,) = msg.sender.call(abi.encodeCall(ExitGuard.deposit, (address(this), 1)));
        }
        balanceOf[to] += taxed ? amount - 1 : amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (fail) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
