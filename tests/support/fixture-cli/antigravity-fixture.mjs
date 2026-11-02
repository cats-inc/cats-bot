// A legacy agy stream-json fixture. Init arrives immediately, followed by a
// response after the old 30-second startup budget. It never uses a real provider.
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('1.1.20');
} else if (args.includes('--help')) {
  console.log('Usage: agy -p <prompt> --output-format stream-json --disable-slash-commands --add-dir <path> --model <model> --conversation <id> --allowed-tools <tools>');
} else {
  const conversationId = randomUUID();
  const emit = value => console.log(JSON.stringify({ conversation_id: conversationId, ...value }));
  emit({ event: 'init', init: { cwd: process.cwd(), tools: [], permission_mode: 'request-review' } });
  setTimeout(() => {
    const text = 'completed after 31 seconds of silence';
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: text } });
    emit({ event: 'result', result: { status: 'SUCCESS', response: text, duration_seconds: 31, num_turns: 1 } });
  }, 31_000);
}
