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
}
