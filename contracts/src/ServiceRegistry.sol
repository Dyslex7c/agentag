// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ServiceRegistry {
    struct Service {
        string name;
        uint256 price;
        address owner;
        bool exists;
    }

    /// @notice Emitted when a caller pays for a service.
    event ServicePaid(address indexed caller, string name, uint256 amount);

    /// @notice service name hash → Service metadata
    mapping(bytes32 => Service) public services;

    /// @notice user address → service name hash → payment timestamp
    mapping(address => mapping(bytes32 => uint256)) public payments;

    /// @notice Access window after payment (10 minutes).
    uint256 public constant ACCESS_DURATION = 10 minutes;

    constructor() {
        _register("summarize", 0.001 ether, msg.sender);
        _register("sentiment", 0.0005 ether, msg.sender);
        _register("translate", 0.0008 ether, msg.sender);
    }

    // ───────── External / Public ─────────

    /// @notice Register a new service.
    function registerService(string calldata name, uint256 price) external {
        bytes32 key = _key(name);
        require(!services[key].exists, "Service already exists");
        require(price > 0, "Price must be > 0");

        services[key] = Service({
            name: name,
            price: price,
            owner: msg.sender,
            exists: true
        });
    }

    /// @notice Pay for a service. `msg.value` must equal the service price.
    function payForService(string calldata name) external payable {
        bytes32 key = _key(name);
        Service storage svc = services[key];
        require(svc.exists, "Service does not exist");
        require(msg.value == svc.price, "Incorrect payment amount");

        payments[msg.sender][key] = block.timestamp;

        // Forward payment to the service owner.
        (bool ok, ) = svc.owner.call{value: msg.value}("");
        require(ok, "Payment transfer failed");

        emit ServicePaid(msg.sender, name, msg.value);
    }

    /// @notice Check whether `user` has paid for `name` within the last 10 minutes.
    function hasAccess(address user, string calldata name) external view returns (bool) {
        bytes32 key = _key(name);
        uint256 paidAt = payments[user][key];
        if (paidAt == 0) return false;
        return (block.timestamp - paidAt) <= ACCESS_DURATION;
    }

    /// @notice Get the price of a service in wei.
    function getServicePrice(string calldata name) external view returns (uint256) {
        bytes32 key = _key(name);
        require(services[key].exists, "Service does not exist");
        return services[key].price;
    }

    // ───────── Internal ─────────

    function _register(string memory name, uint256 price, address owner) internal {
        bytes32 key = _key(name);
        services[key] = Service({
            name: name,
            price: price,
            owner: owner,
            exists: true
        });
    }

    function _key(string memory name) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(name));
    }
}
