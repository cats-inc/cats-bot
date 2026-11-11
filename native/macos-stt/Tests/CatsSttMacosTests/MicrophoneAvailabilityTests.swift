import AVFoundation
import CoreAudio
import Darwin
import Foundation
import Speech
import XCTest

@testable import CatsSttMacos

final class MicrophoneAvailabilityTests: XCTestCase {
  func testMissingInputEndsWithMicUnavailableWithoutStartingRecognition() throws {
    // Query the device list before creating an input node: AVAudioEngine may
    // request microphone access when a device is connected, even before start().
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultInputDevice,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var device = AudioDeviceID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout.size(ofValue: device))
    let status = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device
    )
    guard status == noErr, device == kAudioObjectUnknown else {
      throw XCTSkip("This regression requires a Mac without an available audio input.")
    }

    let recognizer = try XCTUnwrap(SFSpeechRecognizer(locale: Locale(identifier: "en-US")))
    let options = CliOptions(sessionId: "missing-microphone", locale: "en-US", inputPath: nil)
    let emitter = JsonEmitter(sessionId: options.sessionId)
    // Call the real capture path without requesting Speech/Microphone authorization.
    // A missing device must be rejected before a recognition task or tap is created.
    let output = captureStandardOutput {
      runMicrophoneRecognition(options: options, recognizer: recognizer, emitter: emitter)
    }
    let events = try output.split(separator: "\n").map { line in
      try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: String])
    }
    XCTAssertEqual(events, [
      ["type": "error", "sessionId": options.sessionId, "reason": "mic_unavailable"],
      ["type": "end", "sessionId": options.sessionId],
    ])
  }

  private func captureStandardOutput(_ body: () -> Void) -> String {
    let pipe = Pipe()
    fflush(stdout)
    let original = dup(STDOUT_FILENO)
    defer { close(original) }
    dup2(pipe.fileHandleForWriting.fileDescriptor, STDOUT_FILENO)
    body()
    fflush(stdout)
    dup2(original, STDOUT_FILENO)
    pipe.fileHandleForWriting.closeFile()
    return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
  }
}
