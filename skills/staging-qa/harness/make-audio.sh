#!/bin/bash
# Builds the audio fixtures into $QA_HOME/audio (default ~/.cache/dembrane-qa/audio).
# Needs ffmpeg and one TTS: espeak-ng (Linux), say (macOS) or Windows System.Speech (WSL).
set -e
OUT="${QA_HOME:-$HOME/.cache/dembrane-qa}/audio"; mkdir -p "$OUT/many"; cd "$OUT"
say_to(){ # say_to <out.wav> <text>
  if command -v espeak-ng >/dev/null; then espeak-ng -s 150 -w "$1" "$2"
  elif command -v say >/dev/null; then say -o "$1.aiff" "$2" && ffmpeg -loglevel error -y -i "$1.aiff" "$1" && rm "$1.aiff"
  elif command -v powershell.exe >/dev/null; then
    powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.Speech; \$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; \$s.SetOutputToWaveFile('$(wslpath -w "$PWD")\\$1'); \$s.Speak(\"$2\"); \$s.Dispose()"
  else echo "no TTS found (install espeak-ng)"; exit 1; fi
}
say_to t1.wav "Hello, my name is Maria and I live in the north of Amsterdam. I think our neighbourhood really needs more green space. The park near the canal is always crowded on weekends, and children have nowhere safe to play. I would also like better bike lanes on the main road, because cycling to school in the morning feels dangerous. The tram is often late and very full. If the city invested in more frequent trams and new trees along the streets, people would feel happier and healthier here."
say_to t2.wav "Good afternoon. I run a small bakery on the corner of the market square. For me the biggest issue is parking and deliveries. Suppliers cannot stop in front of the shop anymore, so they block the street. Small businesses need a loading zone. I also worry about rising rents. Several shops have closed this year. Maybe the council could support local entrepreneurs with lower fees or a shared delivery hub."
say_to t3.wav "I am a student and I mostly care about housing. It is almost impossible to find an affordable room. The waiting lists for student housing are years long. I would like the municipality to build more small apartments and stop landlords from charging crazy prices. Also, the library should stay open later in the evening."
ffmpeg -loglevel error -y -i t1.wav -i t2.wav -i t3.wav -filter_complex "[0][1][2]concat=n=3:v=0:a=1" -ar 48000 -ac 1 mic90.wav  # fake mic input
ffmpeg -loglevel error -y -f lavfi -i anullsrc=r=48000:cl=mono -t 60 silent.wav                                            # mic check
ffmpeg -loglevel error -y -i t2.wav -codec:a libmp3lame -b:a 64k bakery.mp3
ffmpeg -loglevel error -y -i t3.wav -c:a aac -b:a 64k student.m4a
ffmpeg -loglevel error -y -i t1.wav -ar 16000 -ac 1 maria.wav
yes "plain text pretending to be audio" | head -400 > fake.mp3   # not audio
for i in $(seq 1 11); do cp bakery.mp3 many/b$i.mp3; done      # one over the 10-file upload cap
echo "fixtures ready in $OUT"
