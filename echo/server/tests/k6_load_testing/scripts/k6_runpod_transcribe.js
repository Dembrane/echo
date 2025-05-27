import http from 'k6/http';
import { check, sleep } from 'k6';

// Read config from environment variables
const RUNPOD_API_KEY = __ENV.RUNPOD_API_KEY;
const RUNPOD_ENDPOINT_ID = __ENV.RUNPOD_ENDPOINT_ID;
const AUDIO_URL = __ENV.AUDIO_URL;
const BASE_URL = __ENV.BASE_URL || 'https://api.runpod.ai/v2';
const WHISPER_MODEL = __ENV.WHISPER_MODEL || 'large-v3';
const INITIAL_PROMPT = __ENV.INITIAL_PROMPT || '';
const POLL_INTERVAL = parseInt(__ENV.POLL_INTERVAL || '10', 10); // seconds
const POLL_TIMEOUT = parseInt(__ENV.POLL_TIMEOUT || '1000', 10); // seconds

if (!RUNPOD_API_KEY || !RUNPOD_ENDPOINT_ID || !AUDIO_URL) {
  throw new Error(
    'Missing required environment variables: RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID, AUDIO_URL'
  );
}

// Choose scenario via TEST_TYPE env var: 'smoke', 'load', 'spike', 'stress'
const TEST_TYPE = (__ENV.TEST_TYPE || 'smoke').toLowerCase();

let options = {};
switch (TEST_TYPE) {
  case 'smoke':
    options = {
      vus: 1,
      iterations: 1,
    };
    break;
  case 'load':
    options = {
      vus: 500,
      duration: '10m',
    };
    break;
  case 'spike':
    options = {
      stages: [
        { duration: '30s', target: 1 },
        { duration: '5m', target: 500 },
        { duration: '30s', target: 1 },
      ],
    };
    break;
  case 'stress':
    options = {
      stages: [
        { duration: '2m', target: 1500 },
        { duration: '4m', target: 0 },
      ],
    };
    break;
  default:
    options = { vus: 1, iterations: 1 };
}

export { options };

// Parse AUDIO_URL for multiple files
let audioFiles = [AUDIO_URL];
if (AUDIO_URL.includes(',')) {
  audioFiles = AUDIO_URL.split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

function submitTranscriptionJob() {
  // Randomly select an audio file if multiple are provided
  const selectedAudio =
    audioFiles.length > 1
      ? audioFiles[Math.floor(Math.random() * audioFiles.length)]
      : audioFiles[0];
  const url = `${BASE_URL}/${RUNPOD_ENDPOINT_ID}/run`;
  const headers = {
    Authorization: `Bearer ${RUNPOD_API_KEY}`,
    'Content-Type': 'application/json',
  };
  const payload = JSON.stringify({
    input: {
      audio: selectedAudio,
      model: WHISPER_MODEL,
      initial_prompt: INITIAL_PROMPT,
      language: 'en',
    },
  });
  const res = http.post(url, payload, { headers });
  check(res, {
    'job submitted': (r) => r.status === 200 && r.json('id'),
  });
  return res.json('id');
}

function pollStatus(jobId) {
  const statusUrl = `${BASE_URL}/${RUNPOD_ENDPOINT_ID}/status/${jobId}`;
  const headers = {
    Authorization: `Bearer ${RUNPOD_API_KEY}`,
    'Content-Type': 'application/json',
  };
  let waited = 0;
  while (waited < POLL_TIMEOUT) {
    const res = http.get(statusUrl, { headers });
    const status = res.json('status');
    if (status === 'COMPLETED') {
      check(res, {
        'transcription completed': (r) => !!r.json('output.transcription'),
      });
      return res.json('output.transcription');
    } else if (status === 'FAILED') {
      check(res, { 'transcription failed': () => false });
      return null;
    }
    sleep(POLL_INTERVAL);
    waited += POLL_INTERVAL;
  }
  check(null, { 'timeout waiting for transcription': () => false });
  return null;
}

export default function () {
  const jobId = submitTranscriptionJob();
  if (jobId) {
    pollStatus(jobId);
  }
}
