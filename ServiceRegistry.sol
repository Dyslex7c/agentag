// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ServiceRegistry {
    struct Service {
        string name;
        uint256 price; // in wei
        address owner;
        bool exists;
    }

    mapping(string => Service) public services;
    mapping(address => mapping(string => uint256)) public lastPayment;

    event ServicePaid(address indexed payer, string name, uint256 amount);
    event ServiceRegistered(string name, uint256 price, address owner);

    constructor() {
        _registerService("summarize", 0.001 ether);
        _registerService("sentiment", 0.0005 ether);
        _registerService("translate", 0.0008 ether);
    }

    function _registerService(string memory name, uint256 price) internal {
        services[name] = Service({
            name: name,
            price: price,
            owner: msg.sender,
            exists: true
        });
    }

    function registerService(string calldata name, uint256 price) external {
        services[name] = Service({
            name: name,
            price: price,
            owner: msg.sender,
            exists: true
        });
        emit ServiceRegistered(name, price, msg.sender);
    }

    // Added `payer` param — Facinet submits the tx (msg.sender = facilitator)
    // but access is recorded for `payer` (the actual agent wallet)
    function payForService(string calldata name, address payer) external payable {
        Service storage svc = services[name];
        require(svc.exists, "Service not found");
        require(msg.value >= svc.price, "Insufficient payment");

        lastPayment[payer][name] = block.timestamp;
        emit ServicePaid(payer, name, msg.value);
    }

    function hasAccess(address user, string calldata name) external view returns (bool) {
        return block.timestamp - lastPayment[user][name] < 10 minutes;
    }
}
