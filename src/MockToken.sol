// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal test token for the demo position. Anyone can mint (testnet only).
contract MockToken {
    string public name; string public symbol; uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s) { name = n; symbol = s; }

    function mint(address to, uint256 amt) external { totalSupply += amt; balanceOf[to] += amt; emit Transfer(address(0), to, amt); }
    function approve(address sp, uint256 amt) external returns (bool) { allowance[msg.sender][sp] = amt; emit Approval(msg.sender, sp, amt); return true; }
    function transfer(address to, uint256 amt) external returns (bool) { _t(msg.sender, to, amt); return true; }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) { require(a >= amt, "allowance"); allowance[from][msg.sender] = a - amt; }
        _t(from, to, amt); return true;
    }
    function _t(address f, address t, uint256 amt) internal { require(balanceOf[f] >= amt, "balance"); balanceOf[f] -= amt; balanceOf[t] += amt; emit Transfer(f, t, amt); }
}
