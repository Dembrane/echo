import XCTest
@testable import DembraneCore

final class PasswordRulesTests: XCTestCase {
    func testAPasswordTheServerAcceptsPasses() {
        XCTAssertEqual(PasswordRules.unmet("Recording-2026"), [])
    }

    func testEachMissingRuleIsNamed() {
        XCTAssertEqual(PasswordRules.unmet("GoUi3b6c3f45e52ab82bx9"), ["a symbol"])
        XCTAssertEqual(PasswordRules.unmet("short1!"), ["8 characters", "an uppercase letter"])
        XCTAssertEqual(PasswordRules.unmet(""),
                       ["8 characters", "an uppercase letter", "a lowercase letter", "a number", "a symbol"])
    }

    func testCountsCharactersNotBytesAndReadsAccentsAsSymbols() {
        // The server counts code points and its symbol rule is "not A-Z, a-z or 0-9",
        // so "é" is one character and counts as the symbol.
        XCTAssertEqual(PasswordRules.unmet("Réunio1"), ["8 characters"])
        XCTAssertEqual(PasswordRules.unmet("Réunion1"), [])
    }
}
