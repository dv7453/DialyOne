export const skill = String.raw`
# Voice — Speak & Transcribe

Load this skill to generate spoken audio from text or transcribe audio files to text. Both tools ride Dialy's per-stage voice pipeline: **ElevenLabs Scribe** (STT) → the assistant model → **Sarvam** (TTS). Deepgram STT / ElevenLabs TTS are used only if that stage's key is missing.

## The tools

### \`text-to-speech\` — text → spoken audio in the workspace
- **\`text\`** (required, max 5000 chars) — what to say. For long content, synthesize one segment per call.
- **\`outputPath\`** (optional) — where to save; default \`media/tts/tts-<timestamp>.wav\` or \`.mp3\` depending on the TTS stage.
- **\`languageCode\`** (optional) — Sarvam language (\`en-IN\`, \`hi-IN\`, \`gu-IN\`).
- **\`voiceId\`** (optional) — ElevenLabs voice id, only when Sarvam is not configured.

Returns \`{ path, mimeType, bytes }\`. Tell the user where the file landed.

### \`transcribe-audio\` — audio file → text
- **\`path\`** (required) — the audio file (workspace-relative or absolute). Common formats work: wav, mp3, ogg/opus, webm.

Returns \`{ transcript }\`.

## Notes
- Keep individual TTS calls short; synthesis time and cost scale with text length.
- Transcription of very long recordings takes a while — warn the user for files over ~30 minutes.
`;

export default skill;
