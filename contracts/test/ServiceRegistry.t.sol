// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ServiceRegistry.sol";

contract ServiceRegistryTest is Test {
    ServiceRegistry public registry;
    address public user = address(0xBEEF);

    // Accept AVAX forwarded from payForService (this contract is the service owner).
    receive() external payable {}

    function setUp() public {
        registry = new ServiceRegistry();
        vm.deal(user, 10 ether);
    }

    // ───────── payForService ─────────

    function test_payForService_succeeds() public {
        vm.prank(user);
        registry.payForService{value: 0.001 ether}("summarize");

        assertTrue(registry.hasAccess(user, "summarize"));
    }

    function test_payForService_wrongAmount_reverts() public {
        vm.prank(user);
        vm.expectRevert("Incorrect payment amount");
        registry.payForService{value: 0.002 ether}("summarize");
    }

    function test_payForService_nonexistentService_reverts() public {
        vm.prank(user);
        vm.expectRevert("Service does not exist");
        registry.payForService{value: 0.001 ether}("nonexistent");
    }

    function test_payForService_emitsEvent() public {
        vm.prank(user);
        vm.expectEmit(true, false, false, true);
        emit ServiceRegistry.ServicePaid(user, "summarize", 0.001 ether);
        registry.payForService{value: 0.001 ether}("summarize");
    }

    // ───────── hasAccess ─────────

    function test_hasAccess_falseBeforePayment() public view {
        assertFalse(registry.hasAccess(user, "summarize"));
    }

    function test_hasAccess_trueAfterPayment() public {
        vm.prank(user);
        registry.payForService{value: 0.0005 ether}("sentiment");

        assertTrue(registry.hasAccess(user, "sentiment"));
    }

    // ───────── 10-minute expiry ─────────

    function test_hasAccess_expiredAfter10Minutes() public {
        vm.prank(user);
        registry.payForService{value: 0.001 ether}("summarize");

        // Warp 10 minutes + 1 second into the future
        vm.warp(block.timestamp + 10 minutes + 1);

        assertFalse(registry.hasAccess(user, "summarize"));
    }

    function test_hasAccess_validAt10Minutes() public {
        vm.prank(user);
        registry.payForService{value: 0.001 ether}("summarize");

        // Warp exactly 10 minutes — should still be valid (<= check)
        vm.warp(block.timestamp + 10 minutes);

        assertTrue(registry.hasAccess(user, "summarize"));
    }

    // ───────── Pre-registered services ─────────

    function test_preRegisteredServices_prices() public view {
        assertEq(registry.getServicePrice("summarize"), 0.001 ether);
        assertEq(registry.getServicePrice("sentiment"), 0.0005 ether);
        assertEq(registry.getServicePrice("translate"), 0.0008 ether);
    }

    // ───────── registerService ─────────

    function test_registerService_newService() public {
        registry.registerService("newservice", 0.01 ether);
        assertEq(registry.getServicePrice("newservice"), 0.01 ether);
    }

    function test_registerService_duplicate_reverts() public {
        vm.expectRevert("Service already exists");
        registry.registerService("summarize", 0.01 ether);
    }

    // ───────── Multiple services ─────────

    function test_multipleServices_independentAccess() public {
        vm.startPrank(user);
        registry.payForService{value: 0.001 ether}("summarize");
        registry.payForService{value: 0.0008 ether}("translate");
        vm.stopPrank();

        assertTrue(registry.hasAccess(user, "summarize"));
        assertTrue(registry.hasAccess(user, "translate"));
        assertFalse(registry.hasAccess(user, "sentiment"));
    }
}
