import Foundation
import Speech
import XCTest

@testable import CatsSttMacos

final class RecognitionCallbackTests: XCTestCase {
  func testRecognitionCallbacksRunWhileTheMainThreadWaits() throws {
    XCTAssertTrue(Thread.isMainThread)
    let recognizer = try XCTUnwrap(resolveRecognizer(
      locale: "en-US",
      emitter: JsonEmitter(sessionId: "callback-progress")
    ))
    let delivered = DispatchSemaphore(value: 0)
    // Recognition uses this queue for results and errors. The CLI's main thread
    // waits synchronously, so delivery must not depend on pumping its run loop.
    recognizer.queue.addOperation {
      delivered.signal()
    }
    XCTAssertEqual(delivered.wait(timeout: .now() + 1), .success)
  }
}
