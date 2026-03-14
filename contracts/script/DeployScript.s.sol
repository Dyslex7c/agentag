// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/ServiceRegistry.sol";

contract DeployScript is Script {
    function run() external {
        vm.startBroadcast();

        ServiceRegistry registry = new ServiceRegistry();

        console.log("ServiceRegistry deployed at:", address(registry));

        vm.stopBroadcast();
    }
}
