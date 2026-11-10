import AVFoundation
import Darwin
import Foundation
import Speech

struct CliOptions {
  let sessionId: String
  let locale: String
  let inputPath: String?
}

struct ControlCommand: Decodable {
  let type: String
  let sessionId: String?
}

final class JsonEmitter {
  private let sessionId: String
  private let lock = NSLock()

  init(sessionId: String) {
    self.sessionId = sessionId
  }

  func ready(locale: String) {
    emit([
      "type": "ready",
      "sessionId": sessionId,
      "locale": locale,
      "mode": "on-device",
    ])
  }

  func partial(_ text: String) {
    emit([
      "type": "partial",
      "sessionId": sessionId,
      "text": text,
    ])
  }

  func final(_ text: String) {
    emit([
      "type": "final",
      "sessionId": sessionId,
      "text": text,
    ])
  }

  func error(_ reason: String) {
    emit([
      "type": "error",
      "sessionId": sessionId,
      "reason": reason,
    ])
  }

  func end() {
    emit([
      "type": "end",
      "sessionId": sessionId,
    ])
  }

  private func emit(_ payload: [String: String]) {
    lock.lock()
    defer { lock.unlock() }
    guard
      let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
      let line = String(data: data, encoding: .utf8)
    else {
      return
    }
    print(line)
    fflush(stdout)
  }
}

func fixtureInputIsEnabled() -> Bool {
  return ProcessInfo.processInfo.environment["CATS_STT_ENABLE_FIXTURE_INPUT"] == "1"
}

func parseOptions(
  _ args: [String],
  fixtureInputEnabled: Bool = fixtureInputIsEnabled()
) -> CliOptions? {
  var sessionId: String?
  var locale: String?
  var inputPath: String?
  var index = 1

  while index < args.count {
    let value = args[index]
    switch value {
    case "--session-id":
      sessionId = index + 1 < args.count ? args[index + 1] : nil
      index += 2
    case "--locale":
      locale = index + 1 < args.count ? args[index + 1] : nil
      index += 2
    case "--input":
      guard fixtureInputEnabled else {
        return nil
      }
      inputPath = index + 1 < args.count ? args[index + 1] : nil
      index += 2
    default:
      return nil
    }
  }

  guard let sessionId, !sessionId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    return nil
  }

  return CliOptions(
    sessionId: sessionId,
    locale: locale ?? Locale.current.identifier.replacingOccurrences(of: "_", with: "-"),
    inputPath: inputPath
  )
}

func parseControlCommand(_ line: String, sessionId: String) -> String? {
  guard
    let data = line.data(using: .utf8),
    let command = try? JSONDecoder().decode(ControlCommand.self, from: data),
    command.sessionId == sessionId,
    command.type == "stop" || command.type == "cancel"
  else {
    return nil
  }
  return command.type
}

func mapRecognitionError(_ error: Error) -> String {
  let nsError = error as NSError
  if nsError.domain == AVFoundationErrorDomain {
    return "mic_unavailable"
  }
  return "engine_unavailable"
}

func awaitSpeechAuthorization() -> SFSpeechRecognizerAuthorizationStatus {
  let current = SFSpeechRecognizer.authorizationStatus()
  if current != .notDetermined {
    return current
  }

  let semaphore = DispatchSemaphore(value: 0)
  var nextStatus = current
  SFSpeechRecognizer.requestAuthorization { status in
    nextStatus = status
    semaphore.signal()
  }
  semaphore.wait()
  return nextStatus
}

func awaitMicrophoneAuthorization() -> AVAuthorizationStatus {
  let current = AVCaptureDevice.authorizationStatus(for: .audio)
  if current != .notDetermined {
    return current
  }

  let semaphore = DispatchSemaphore(value: 0)
  var granted = false
  AVCaptureDevice.requestAccess(for: .audio) { allowed in
    granted = allowed
    semaphore.signal()
  }
  semaphore.wait()
  return granted ? .authorized : .denied
}

func preflightPermissions(options: CliOptions, emitter: JsonEmitter) -> Bool {
  let speechStatus = awaitSpeechAuthorization()
  if speechStatus == .denied || speechStatus == .restricted {
    emitter.error("permission_denied")
    emitter.end()
    return false
  }
  if speechStatus != .authorized {
    emitter.error("permission_not_determined")
    emitter.end()
    return false
  }

  if options.inputPath == nil {
    let microphoneStatus = awaitMicrophoneAuthorization()
    if microphoneStatus == .denied || microphoneStatus == .restricted {
      emitter.error("permission_denied")
      emitter.end()
      return false
    }
    if microphoneStatus != .authorized {
      emitter.error("permission_not_determined")
      emitter.end()
      return false
    }
  }

  return true
}

func resolveRecognizer(locale: String, emitter: JsonEmitter) -> SFSpeechRecognizer? {
  let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
  guard let recognizer, recognizer.isAvailable else {
    emitter.error("language_not_supported")
    emitter.end()
    return nil
  }
  guard recognizer.supportsOnDeviceRecognition else {
    emitter.error("language_not_supported")
    emitter.end()
    return nil
  }
  return recognizer
}

func configureOnDevice(_ request: SFSpeechRecognitionRequest) {
  request.shouldReportPartialResults = true
  if #available(macOS 10.15, *) {
    request.requiresOnDeviceRecognition = true
  }
}

func runFileRecognition(
  options: CliOptions,
  recognizer: SFSpeechRecognizer,
  emitter: JsonEmitter
) {
  guard let inputPath = options.inputPath else {
    return
  }

  let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: inputPath))
  configureOnDevice(request)
  let semaphore = DispatchSemaphore(value: 0)

  emitter.ready(locale: options.locale)
  let task = recognizer.recognitionTask(with: request) { result, error in
    if let result {
      let text = result.bestTranscription.formattedString
      if result.isFinal {
        emitter.final(text)
        emitter.end()
        semaphore.signal()
      } else {
        emitter.partial(text)
      }
      return
    }
    if let error {
      emitter.error(mapRecognitionError(error))
      emitter.end()
      semaphore.signal()
    }
  }

  semaphore.wait()
  task.cancel()
}

func runMicrophoneRecognition(
  options: CliOptions,
  recognizer: SFSpeechRecognizer,
  emitter: JsonEmitter
) {
  let audioEngine = AVAudioEngine()
  let request = SFSpeechAudioBufferRecognitionRequest()
  configureOnDevice(request)

  let semaphore = DispatchSemaphore(value: 0)
  var task: SFSpeechRecognitionTask?
  var ended = false
  var audioEnded = false
  let endLock = NSLock()

  func stopAudioInput() {
    endLock.lock()
    if audioEnded {
      endLock.unlock()
      return
    }
    audioEnded = true
    endLock.unlock()

    if audioEngine.isRunning {
      audioEngine.stop()
    }
    audioEngine.inputNode.removeTap(onBus: 0)
    request.endAudio()
  }

  func finishSession(sendEnd: Bool = true, cancelTask: Bool) {
    endLock.lock()
    if ended {
      endLock.unlock()
      return
    }
    ended = true
    endLock.unlock()

    stopAudioInput()
    if cancelTask {
      task?.cancel()
    }
    if sendEnd {
      emitter.end()
    }
    semaphore.signal()
  }

  task = recognizer.recognitionTask(with: request) { result, error in
    if let result {
      let text = result.bestTranscription.formattedString
      if result.isFinal {
        emitter.final(text)
        finishSession(cancelTask: false)
        return
      } else {
        emitter.partial(text)
      }
    }
    if let error {
      emitter.error(mapRecognitionError(error))
      finishSession(cancelTask: true)
    }
  }

  let inputNode = audioEngine.inputNode
  let format = inputNode.outputFormat(forBus: 0)
  inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
  }

  do {
    audioEngine.prepare()
    try audioEngine.start()
  } catch {
    emitter.error("mic_unavailable")
    finishSession(cancelTask: true)
    return
  }

  emitter.ready(locale: options.locale)

  DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
      let command = parseControlCommand(line, sessionId: options.sessionId)
      if command == "cancel" {
        emitter.error("cancelled")
        finishSession(cancelTask: true)
        return
      }
      if command == "stop" {
        stopAudioInput()
        // SFSpeechRecognizer does not always deliver an `isFinal` callback after
        // endAudio() — empty buffers and very short utterances can leave the
        // task silent. Schedule a bounded fallback so the helper still finishes
        // promptly instead of waiting the full host-side stop cleanup window.
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.8) {
          finishSession(cancelTask: true)
        }
        return
      }
    }
    finishSession(cancelTask: true)
  }

  semaphore.wait()
}

guard let options = parseOptions(CommandLine.arguments) else {
  fputs("Usage: cats-stt-macos --session-id <id> [--locale <bcp47>] [--input <wav>]\n", stderr)
  exit(2)
}

let emitter = JsonEmitter(sessionId: options.sessionId)
guard preflightPermissions(options: options, emitter: emitter) else {
  exit(0)
}
guard let recognizer = resolveRecognizer(locale: options.locale, emitter: emitter) else {
  exit(0)
}

if options.inputPath != nil {
  runFileRecognition(options: options, recognizer: recognizer, emitter: emitter)
} else {
  runMicrophoneRecognition(options: options, recognizer: recognizer, emitter: emitter)
}
