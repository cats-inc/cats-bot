// Ported from Cats Desktop tests/voice-native-helper-source.test.js (cats-platform 6a2a1b02); SPEC-003 FR-10.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

test('macOS STT helper enforces on-device recognition and typed bridge events', async () => {
  const source = await readFile(
    join(
      process.cwd(),
      'native',
      'macos-stt',
      'Sources',
      'CatsSttMacos',
      'main.swift',
    ),
    'utf8',
  );

  assert.match(source, /import Speech/u);
  assert.match(source, /supportsOnDeviceRecognition/u);
  assert.match(source, /requiresOnDeviceRecognition = true/u);
  assert.match(source, /"mode": "on-device"/u);
  assert.match(source, /"language_not_supported"/u);
  assert.match(source, /"permission_denied"/u);
  // ADR-020 (Cats Desktop ADR-147): a denied Speech Recognition is reported apart from the microphone.
  assert.match(source, /speechStatus == \.denied \|\| speechStatus == \.restricted \{[\s\S]*?"speech_permission_denied"/u);
  assert.match(source, /"permission_not_determined"/u);
  // ADR-020: the shell asks for Screen Recording through this helper.
  assert.match(source, /"--request-screen-capture"/u);
  assert.match(source, /CGRequestScreenCaptureAccess\(\)/u);
  assert.match(source, /SFSpeechURLRecognitionRequest/u);
  assert.match(source, /SFSpeechAudioBufferRecognitionRequest/u);
  assert.match(source, /options\.inputPath == nil/u);
  assert.match(source, /CATS_STT_ENABLE_FIXTURE_INPUT/u);
  assert.match(source, /JSONDecoder\(\)\.decode\(ControlCommand\.self/u);
  assert.match(source, /parseControlCommand\(line, sessionId: options\.sessionId\)/u);
  assert.match(source, /stopAudioInput\(\)[\s\S]*return/u);
  assert.match(source, /finishSession\(cancelTask: false\)/u);
  assert.match(source, /if cancelTask \{\s*task\?\.cancel\(\)/u);
  // Bounded fallback so an empty audio buffer cannot leave the helper waiting
  // for an `isFinal` callback that SFSpeechRecognizer may never deliver.
  assert.match(source, /asyncAfter\(deadline: \.now\(\) \+ 0\.8\)/u);
  assert.doesNotMatch(source, /line\.contains/u);
});

test('Windows STT helper uses WinRT speech and reports unknown locality', async () => {
  const source = await readFile(
    join(process.cwd(), 'native', 'windows-stt', 'Program.cs'),
    'utf8',
  );
  const project = await readFile(
    join(process.cwd(), 'native', 'windows-stt', 'CatsSttWindows.csproj'),
    'utf8',
  );

  assert.match(project, /net8\.0-windows10\.0\.19041\.0/u);
  assert.match(source, /Windows\.Media\.SpeechRecognition/u);
  assert.match(source, /ContinuousRecognitionSession/u);
  assert.match(source, /HypothesisGenerated/u);
  assert.match(source, /ResultGenerated/u);
  assert.match(source, /"mode"\] = "unknown"/u);
  assert.match(source, /UnauthorizedAccessException/u);
  assert.match(source, /"permission_denied"/u);
  assert.match(source, /"language_not_supported"/u);
  assert.match(source, /"engine_unavailable"/u);
  assert.match(source, /JsonSerializer\.Deserialize<ControlCommand>/u);
  assert.match(source, /command\?\.SessionId != sessionId/u);
  assert.doesNotMatch(source, /line\.Contains/u);
});
