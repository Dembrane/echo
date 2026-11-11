const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/**
 * Seconds of audio in an mp3 file, read from its first frame: the frame count in a Xing or Info
 * header when there is one (every file ffmpeg writes has it, VBR included), otherwise the file
 * size at the first frame's bitrate. Null for anything that is not an mp3 or has no readable
 * frame. The pacing and the request log use it where the caller does not know the length.
 */
export function mp3Seconds(audio: Uint8Array): number | null {
  let i = 0;
  // An ID3v2 tag in front: its size is four 7-bit bytes.
  if (audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33 && audio.length > 10) {
    i =
      10 +
      (((audio[6] as number) & 0x7f) << 21) +
      (((audio[7] as number) & 0x7f) << 14) +
      (((audio[8] as number) & 0x7f) << 7) +
      ((audio[9] as number) & 0x7f);
  }
  for (let n = 0; n < 4096 && i + 4 < audio.length; n++, i++) {
    const h0 = audio[i] as number;
    const h1 = audio[i + 1] as number;
    if (h0 !== 0xff || (h1 & 0xe0) !== 0xe0) continue;
    const version = (h1 >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (h1 >> 1) & 3; // 1 = layer III
    const h2 = audio[i + 2] as number;
    const bitrateIndex = h2 >> 4;
    const rateIndex = (h2 >> 2) & 3;
    if (
      version === 1 ||
      layer !== 1 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15 ||
      rateIndex === 3
    )
      continue;
    const rate = (RATES[version] as number[])[rateIndex] as number;
    const kbps = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex] as number;
    const samplesPerFrame = version === 3 ? 1152 : 576;
    const mono = (audio[i + 3] as number) >> 6 === 3;
    const sideInfo = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const tag = i + 4 + sideInfo;
    const word = String.fromCharCode(...audio.slice(tag, tag + 4));
    if ((word === "Xing" || word === "Info") && tag + 12 <= audio.length) {
      const flags =
        ((audio[tag + 4] as number) << 24) |
        ((audio[tag + 5] as number) << 16) |
        ((audio[tag + 6] as number) << 8) |
        (audio[tag + 7] as number);
      if (flags & 1) {
        const frames =
          (((audio[tag + 8] as number) << 24) |
            ((audio[tag + 9] as number) << 16) |
            ((audio[tag + 10] as number) << 8) |
            (audio[tag + 11] as number)) >>>
          0;
        // A header written to a pipe could not be filled in afterwards: zero frames means unknown.
        if (frames > 0) return (frames * samplesPerFrame) / rate;
      }
    }
    return ((audio.length - i) * 8) / (kbps * 1000);
  }
  return null;
}
