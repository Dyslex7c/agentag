// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/ServiceRegistry.sol";

contract DeployScript is Script {
    // Circle's USDC on Avalanche Fuji testnet
    // Get test USDC at: https://faucet.circle.com
    address constant USDC_FUJI = 0x5425890298aed601595a70AB815c96711a31Bc65;

    function run() external {
        vm.startBroadcast();

        ServiceRegistry registry = new ServiceRegistry(USDC_FUJI);

        console.log("ServiceRegistry deployed at:", address(registry));
        console.log("USDC address:               ", USDC_FUJI);

        vm.stopBroadcast();
    }
}
