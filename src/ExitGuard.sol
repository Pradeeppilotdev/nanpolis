// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Owner-defined policy vault. An off-chain agent reads Nansen smart money netflow
/// and may call protect(), but the contract only lets it act inside the owner's policy:
/// distribution must reach the owner's threshold over the owner's window, each trigger
/// moves at most maxBps, triggers respect a cooldown, and funds only ever go to the
/// owner's safe address. The Nansen reading that justified the call is logged as an evidence hash.
contract ExitGuard {
    struct Policy {
        address guard;          // agent allowed to trigger (address(0) = revoked)
        address safeAddr;       // where protected funds are sent
        uint128 thresholdUsd;   // min smart money net distribution (USD, whole dollars) to allow a trigger
        uint32 windowSecs;      // window the signal must be measured over
        uint16 maxBps;          // max share of the deposit moved per trigger (10000 = 100%)
        uint32 cooldownSecs;    // min time between triggers
        uint64 lastTrigger;
    }

    mapping(address => mapping(address => uint256)) public deposits; // owner => token => amount
    mapping(address => mapping(address => Policy)) public policies;  // owner => token => policy

    event Deposited(address indexed owner, address indexed token, uint256 amount);
    event Withdrawn(address indexed owner, address indexed token, uint256 amount);
    event PolicySet(
        address indexed owner, address indexed token, address guard, address safeAddr,
        uint128 thresholdUsd, uint32 windowSecs, uint16 maxBps, uint32 cooldownSecs
    );
    event Protected(
        address indexed owner, address indexed token, address indexed guard,
        uint256 amountMoved, uint16 bps, uint256 distributionUsd, uint32 windowSecs, bytes32 evidenceHash
    );

    error NotGuard();
    error BadPolicy();
    error BpsTooHigh();
    error WindowMismatch();
    error BelowThreshold();
    error Cooldown();
    error NothingToMove();
    error InsufficientDeposit();
    error TransferFailed();

    function setPolicy(
        address token, address guard, address safeAddr,
        uint128 thresholdUsd, uint32 windowSecs, uint16 maxBps, uint32 cooldownSecs
    ) external {
        if (safeAddr == address(0) || maxBps == 0 || maxBps > 10_000 || windowSecs == 0) revert BadPolicy();
        Policy storage p = policies[msg.sender][token];
        p.guard = guard;
        p.safeAddr = safeAddr;
        p.thresholdUsd = thresholdUsd;
        p.windowSecs = windowSecs;
        p.maxBps = maxBps;
        p.cooldownSecs = cooldownSecs;
        emit PolicySet(msg.sender, token, guard, safeAddr, thresholdUsd, windowSecs, maxBps, cooldownSecs);
    }

    function revokeGuard(address token) external {
        Policy storage p = policies[msg.sender][token];
        p.guard = address(0);
        emit PolicySet(msg.sender, token, address(0), p.safeAddr, p.thresholdUsd, p.windowSecs, p.maxBps, p.cooldownSecs);
    }

    function deposit(address token, uint256 amount) external {
        deposits[msg.sender][token] += amount;
        _safeTransferFrom(token, msg.sender, address(this), amount);
        emit Deposited(msg.sender, token, amount);
    }

    function withdraw(address token, uint256 amount) external {
        uint256 bal = deposits[msg.sender][token];
        if (amount > bal) revert InsufficientDeposit();
        deposits[msg.sender][token] = bal - amount;
        _safeTransfer(token, msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    /// @param distributionUsd smart money net distribution over the window, in whole USD (positive number)
    /// @param evidenceHash keccak256 of the raw Nansen response that produced the signal
    function protect(
        address owner, address token, uint16 bps,
        uint256 distributionUsd, uint32 windowSecs, bytes32 evidenceHash
    ) external {
        Policy storage p = policies[owner][token];
        if (p.guard == address(0) || msg.sender != p.guard) revert NotGuard();
        if (bps == 0 || bps > p.maxBps) revert BpsTooHigh();
        if (windowSecs != p.windowSecs) revert WindowMismatch();
        if (distributionUsd < p.thresholdUsd) revert BelowThreshold();
        if (p.lastTrigger != 0 && block.timestamp < uint256(p.lastTrigger) + p.cooldownSecs) revert Cooldown();

        uint256 bal = deposits[owner][token];
        uint256 amount = (bal * bps) / 10_000;
        if (amount == 0) revert NothingToMove();

        p.lastTrigger = uint64(block.timestamp);
        deposits[owner][token] = bal - amount;
        _safeTransfer(token, p.safeAddr, amount);

        emit Protected(owner, token, msg.sender, amount, bps, distributionUsd, windowSecs, evidenceHash);
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
