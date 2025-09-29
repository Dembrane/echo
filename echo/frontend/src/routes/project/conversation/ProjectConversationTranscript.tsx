import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  useConversationById,
  useInfiniteConversationChunks,
  useRetranscribeConversationMutation,
  useConversationContentUrl,
  useConversationTranscriptString,
} from "@/components/conversation/hooks";
import {
  ActionIcon,
  Group,
  Stack,
  Tooltip,
  Skeleton,
  Title,
  Modal,
  Button,
  TextInput,
  CopyButton,
  Switch,
  Alert,
  Text,
  Badge,
  Paper,
  Divider,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconAlertCircle,
  IconRefresh,
  IconFileText,
  IconPlayerSkipBack,
  IconPlayerSkipForward,
  IconPlayerPlay,
  IconPlayerPause,
} from "@tabler/icons-react";
import { diffArrays } from "diff";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams } from "react-router";
import useSessionStorageState from "use-session-storage-state";
import { useInView } from "react-intersection-observer";
import { ConversationChunkAudioTranscript } from "@/components/conversation/ConversationChunkAudioTranscript";
import { ExponentialProgress } from "@/components/common/ExponentialProgress";

/** ===== Types ===== */

type ChunkLite = {
  id: string;
  conversation_id: string;
  path?: string | null;
  timestamp?: string | null;
  transcript?: string | null;
  error?: string | null;
  diarization?: any | null;
};

type Word = { text: string; start: number; end: number; confidence?: number };
type Segment = { id: string; text: string; startSec: number; endSec: number };

/** ===== Small utils ===== */

const isMs = (v: number) => v > 600;
const toSec = (v: number) => (isMs(v) ? v / 1000 : v);

function splitSentences(s: string): string[] {
  if (!s?.trim()) return [];
  const matches = s.replace(/\r\n/g, "\n").match(/[^.!?\n]+[.!?]?(?:\s+|$)/g);
  if (!matches) return [s.trim()];
  return matches.map((p) => p.trim()).filter(Boolean);
}

function normalizeToken(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKC")
    // Remove all characters that are not Unicode letters or numbers
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function tokenize(str: string) {
  // Keep original text and token boundaries
  const raw = str || "";
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.map((p) => ({ raw: p, norm: normalizeToken(p) }));
}

/** Group sentences into paragraphs with a soft cap. */
function groupSentencesToParagraphs(sentences: string[], maxChars = 280, maxSentences = 3) {
  const paras: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const s of sentences) {
    if (!s) continue;
    if (cur.length >= maxSentences || curLen + s.length > maxChars) {
      paras.push(cur.join(" "));
      cur = [];
      curLen = 0;
    }
    cur.push(s);
    curLen += s.length + 1;
  }
  if (cur.length) paras.push(cur.join(" "));
  return paras.length ? paras : [sentences.join(" ")];
}

/** Diff-based alignment of enhanced tokens to raw tokens with times. */
function alignEnhancedToRawTimes(enhancedText: string, rawWords: Word[]): {
  matchedTimes: Array<{ start: number; end: number } | null>;
  totalDurationSec: number;
} {
  const confidenceThreshold = 0.4;
  const rawTokens = rawWords.map((w, i) => ({
    norm:
      (w.confidence ?? 1.0) >= confidenceThreshold ? normalizeToken(String(w.text ?? "")) : "",
    start: toSec(Number(w.start ?? 0)),
    end: toSec(Number(w.end ?? 0)),
    i,
  }));
  const enhTokens = tokenize(enhancedText);

  // Use normalized tokens for diffing
  const rawNorms = rawTokens.map((t) => t.norm);
  const enhNorms = enhTokens.map((t) => t.norm);

  const parts = diffArrays(rawNorms, enhNorms);

  const matchedTimes: Array<{ start: number; end: number } | null> = new Array(enhTokens.length).fill(
    null,
  );
  let rp = 0; // raw pointer
  let ep = 0; // enhanced pointer

  for (const part of parts) {
    if (part.added) {
      ep += part.value.length;
    } else if (part.removed) {
      rp += part.value.length;
    } else {
      // Common part
      for (let i = 0; i < part.value.length; i++) {
        if (rp < rawTokens.length && ep < enhTokens.length) {
          if (enhNorms[ep]) { // Check for actual word
            matchedTimes[ep] = { start: rawTokens[rp].start, end: rawTokens[rp].end };
          }
        }
        rp++;
        ep++;
      }
    }
  }

  const total = rawTokens.length ? rawTokens[rawTokens.length - 1].end : 0;

  // If the enhanced transcript has more tokens at the end, estimate their duration
  // and extend the total duration to make sure they are shown.
  // Average speech rate is ~150 words per minute, so 4 words per second.
  // This is a rough heuristic.
  let projectedTotal = total;
  const lastPart = parts[parts.length - 1];
  if (lastPart && lastPart.added && ep === enhTokens.length) {
    const addedWords = lastPart.value.length;
    const estimatedExtraSec = addedWords / 4.0;
    projectedTotal += estimatedExtraSec;
  }

  return { matchedTimes, totalDurationSec: projectedTotal };
}

/** Paragraph-level segments from alignment with interpolation + smoothing */
function paragraphsFromAlignment(enhancedText: string, rawWords: Word[]): Segment[] {
  const sentences = splitSentences(enhancedText);
  const paras = groupSentencesToParagraphs(sentences);
  if (!paras.length) return [];

  const { matchedTimes, totalDurationSec } = alignEnhancedToRawTimes(enhancedText, rawWords);

  // Map tokens to paragraphs by walking paragraphs’ words
  const paraTokensIdx: Array<{ startIdx: number; endIdx: number }> = [];
  {
    let idx = 0;
    for (const p of paras) {
      const pCount = tokenize(p).length;
      const startIdx = idx;
      const endIdx = Math.max(idx, idx + pCount - 1);
      paraTokensIdx.push({ startIdx, endIdx });
      idx = endIdx + 1;
    }
  }

  // Initial times from anchors
  const segs: Segment[] = paras.map((p, k) => {
    const { startIdx, endIdx } = paraTokensIdx[k];
    let firstT: number | null = null;
    let maxT: number | null = null;
    for (let i = startIdx; i <= endIdx && i < matchedTimes.length; i++) {
      const t = matchedTimes[i];
      if (t == null) continue;
      if (firstT == null) firstT = t.start;
      if (maxT == null || t.end > maxT) maxT = t.end;
    }
    return {
      id: `p-${k}`,
      text: p,
      startSec: firstT ?? NaN, // temporary
      endSec: maxT ?? NaN,
    };
  });

  // Interpolate missing times
  const n = segs.length;
  const firstKnown = segs.findIndex((s) => Number.isFinite(s.startSec));
  const lastKnown = (() => {
    for (let i = n - 1; i >= 0; i--) {
      if (Number.isFinite(segs[i].endSec)) return i;
    }
    return -1;
  })();

  // Proportional time allocation helper based on character length
  const distributeTimeProportionally = (
    segments: Segment[],
    startTime: number,
    duration: number,
  ) => {
    if (!segments.length || duration <= 0) return;
    const totalChars = segments.reduce((acc, s) => acc + s.text.length, 0);
    if (totalChars > 0) {
      let timeCursor = startTime;
      for (const seg of segments) {
        const ratio = seg.text.length / totalChars;
        const segDuration = ratio * duration;
        seg.startSec = timeCursor;
        seg.endSec = timeCursor + segDuration;
        timeCursor += segDuration;
      }
    } else { // Fallback for empty/no-text segments
      const segDuration = duration / segments.length;
      segments.forEach((seg, i) => {
        seg.startSec = startTime + i * segDuration;
        seg.endSec = startTime + (i + 1) * segDuration;
      });
    }
  };

  if (firstKnown === -1 || lastKnown === -1) {
    distributeTimeProportionally(segs, 0, totalDurationSec);
  } else {
    // Fill leading unknowns
    if (firstKnown > 0) {
      const duration = segs[firstKnown].startSec;
      distributeTimeProportionally(segs.slice(0, firstKnown), 0, duration);
    }
    // Fill trailing unknowns
    if (lastKnown < n - 1) {
      const startTime = segs[lastKnown].endSec;
      const duration = totalDurationSec - startTime;
      distributeTimeProportionally(segs.slice(lastKnown + 1), startTime, duration);
    }
    // In-between unknowns
    let i = firstKnown;
    while (i < lastKnown) {
      let j = i + 1;
      while (j < n && !Number.isFinite(segs[j].startSec)) j++;
      if (j > i + 1) { // Found a gap of unknowns
        const startTime = segs[i].endSec;
        const endTime = segs[j].startSec;
        const duration = Math.max(0, endTime - startTime);
        distributeTimeProportionally(segs.slice(i + 1, j), startTime, duration);
      }
      i = j;
    }
  }

  // Smoothing: monotonic non-overlap and bounds
  let last = 0;
  for (const s of segs) {
    if (!Number.isFinite(s.startSec)) s.startSec = last;
    s.startSec = Math.max(0, Math.min(s.startSec, totalDurationSec));
    s.endSec = Math.max(s.startSec + 0.2, Math.min(s.endSec, totalDurationSec || s.startSec + 0.2));
    last = s.endSec;
  }

  return segs;
}

/** ===== Component ===== */

export const ProjectConversationTranscript = () => {
  const { conversationId } = useParams();
  const conversationQuery = useConversationById({
    conversationId: conversationId ?? "",
    loadConversationChunks: true,
  });

  const { ref: loadMoreRef, inView } = useInView();
  const {
    data: chunksData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    status,
  } = useInfiniteConversationChunks(conversationId ?? "");

  const transcriptQuery = useConversationTranscriptString(conversationId ?? "");

  // Audio
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeChunkId, setActiveChunkId] = useState<string | null>(null);

  // UI prefs
  const [legacyView, setLegacyView] = useSessionStorageState<boolean>(
    "conversation-transcript-legacy",
    { defaultValue: false }
  );
  const [showAudioPlayer, setShowAudioPlayer] = useSessionStorageState<boolean>(
    "conversation-transcript-show-audio-player",
    { defaultValue: false }
  );

  // Merged audio URL
  const hasMergedAudio = !!conversationQuery.data?.merged_audio_path;
  const mergedAudioUrlQuery = useConversationContentUrl(
    conversationId ?? "",
    Boolean(conversationId) && hasMergedAudio
  );
  const mergedAudioSignedUrl = mergedAudioUrlQuery.data ?? "";
  const mergedAudioLoading = mergedAudioUrlQuery.isLoading;
  const mergedAudioError = mergedAudioUrlQuery.isError;
  const mergedPlayerReady =
    !!mergedAudioSignedUrl &&
    !mergedAudioLoading &&
    !mergedAudioError &&
    mergedAudioSignedUrl.startsWith("http");

  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Modals
  const [downloadOpened, { open: openDownload, close: closeDownload }] =
    useDisclosure(false);
  const [filename, setFilename] = useState("");

  const [
    retranscribeOpened,
    { open: openRetranscribe, close: closeRetranscribe },
  ] = useDisclosure(false);
  const [newConversationName, setNewConversationName] = useState("");
  const retranscribeMutation = useRetranscribeConversationMutation();

  useEffect(() => {
    if (conversationQuery.data?.participant_name) {
      setNewConversationName(conversationQuery.data.participant_name);
    }
  }, [conversationQuery.data]);



  const allChunks: ChunkLite[] =
    chunksData?.pages.flatMap((page) => page.chunks as ChunkLite[]) ?? [];

  const hasValidTranscripts = allChunks.some(
    (c) => c.transcript && c.transcript.trim().length > 0
  );
  const isEmptyConversation =
    !hasValidTranscripts && conversationQuery.data?.is_finished;

  /** Per-chunk offsets for merged audio */
  const offsets = useMemo(() => {
    let acc = 0;
    const map: Record<string, { start: number; end: number; duration: number }> = {};
    for (const c of allChunks) {
      const words: Word[] | undefined = c?.diarization?.data?.raw?.words;
      let durSec = 0;
      if (Array.isArray(words) && words.length > 0) {
        const lastEnd = words[words.length - 1].end ?? 0;
        durSec = toSec(lastEnd);
      } else if (c.transcript) {
        durSec = Math.max(5, Math.min(120, c.transcript.length / 20));
      } else {
        durSec = 10;
      }
      map[c.id] = { start: acc, end: acc + durSec, duration: durSec };
      acc += durSec;
    }
    return map;
  }, [allChunks]);

  /** Compute aligned paragraph segments for each chunk (conversation-level) */
  const chunkSegments: Record<string, Segment[]> = useMemo(() => {
    const out: Record<string, Segment[]> = {};
    for (const c of allChunks) {
      const enhanced = c.transcript ?? "";
      const words: Word[] = Array.isArray(c?.diarization?.data?.raw?.words)
        ? c.diarization.data.raw.words
        : [];
      const segs = paragraphsFromAlignment(enhanced, words);
      out[c.id] = segs;
    }
    return out;
  }, [allChunks]);

  const mergedDiarization = useMemo(() => {
    if (!hasMergedAudio || !allChunks.length) return null;
    const rawTexts = allChunks
      .map((c) => c.diarization?.data?.raw?.text)
      .filter(Boolean);
    const notes = allChunks.map((c) => c.diarization?.data?.note).filter(Boolean);
    if (!rawTexts.length) return null;
    return {
      schema: "Dembrane-25-09",
      data: {
        note: notes.join(" "),
        raw: { text: rawTexts.join("\n") },
      },
    };
  }, [hasMergedAudio, allChunks]);

  const mergedSegments = useMemo(() => {
    if (!hasMergedAudio) return [];
    return allChunks.flatMap(c => {
      const segs = chunkSegments[c.id] ?? [];
      const offset = offsets[c.id]?.start ?? 0;
      return segs.map(s => ({
        ...s,
        id: `${c.id}-${s.id}`, // ensure unique segment IDs
        startSec: s.startSec + offset,
        endSec: s.endSec + offset,
      }));
    });
  }, [hasMergedAudio, allChunks, chunkSegments, offsets]);

  // Active chunk from currentTime
  const calculateActiveChunk = useCallback(
    (t: number) => {
      for (const c of allChunks) {
        const o = offsets[c.id];
        if (!o) continue;
        if (t >= o.start && t < o.end) return c.id;
      }
      return null;
    },
    [allChunks, offsets]
  );

  // Audio handlers
  const onTime = useCallback(() => {
    if (!audioRef.current) return;
    const time = audioRef.current.currentTime;
    setCurrentTime(time);
    const id = calculateActiveChunk(time);
    if (id !== activeChunkId) setActiveChunkId(id);
  }, [activeChunkId, calculateActiveChunk]);

  const onLoaded = useCallback(() => {
    if (audioRef.current) setDuration(audioRef.current.duration);
  }, []);

  const seekAbs = useCallback(
    (time: number) => {
      if (!audioRef.current) return;
      audioRef.current.currentTime = Math.max(0, Math.min(time, duration || time));
      setCurrentTime(audioRef.current.currentTime);
    },
    [duration],
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const typing =
        tag === "input" || tag === "textarea" || (e.target as HTMLElement)?.isContentEditable;
      if (typing) return;

      if (e.code === "Space") {
        e.preventDefault();
        if (!audioRef.current) return;
        if (audioRef.current.paused) {
          audioRef.current.play(); setIsPlaying(true);
        } else {
          audioRef.current.pause(); setIsPlaying(false);
        }
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        seekAbs((audioRef.current?.currentTime || 0) - 5);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        seekAbs((audioRef.current?.currentTime || 0) + 5);
      } else if (e.key === "j") {
        window.dispatchEvent(new CustomEvent("dembrane-transcript-prev"));
      } else if (e.key === "k") {
        window.dispatchEvent(new CustomEvent("dembrane-transcript-next"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seekAbs]);

  const handleDownloadTranscript = (fn: string) => {
    const text = transcriptQuery.data ?? "";
    const blob = new Blob([text], { type: "text/markdown" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    if (conversationQuery.data) {
      a.download = fn !== ""
        ? fn
        : `Conversation-${conversationQuery.data.participant_email}.md`;
    }
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const handleRetranscribe = async () => {
    const { conversationId: cid } = { conversationId };
    if (!cid || !newConversationName.trim()) return;
    await retranscribeMutation.mutateAsync({
      conversationId: cid,
      newConversationName: newConversationName.trim(),
    });
    closeRetranscribe();
  };

  if (status === "pending") {
    return (
      <Stack>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={200} />
        ))}
      </Stack>
    );
  }

  return (
    <Stack>
      {/* Audio player when merged */}
      {hasMergedAudio && showAudioPlayer && (
        <Paper p="md" className="sticky top-2 z-40 bg-white shadow-lg" withBorder>
          <Stack gap="xs">
            <Group justify="space-between" align="center">
              <Group gap="xs">
                <Badge variant="light" color="blue" leftSection={<IconFileText size={12} />}>
                  <Trans>Conversation Audio</Trans>
                </Badge>
              </Group>
            </Group>

            {mergedAudioLoading && <Skeleton height={40} radius="sm" />}
            {mergedAudioError && (
              <Alert color="red" variant="light">
                <Trans>We couldn't load the audio. Please try again later.</Trans>
              </Alert>
            )}
            {mergedPlayerReady && (
              <>
                <audio
                  ref={audioRef}
                  src={mergedAudioSignedUrl}
                  key={mergedAudioSignedUrl}
                  className="w-full h-10"
                  controls
                  onTimeUpdate={onTime}
                  onLoadedMetadata={onLoaded}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  preload="metadata"
                />
                <Group gap="xs" justify="flex-end">
                  <Tooltip label={t`-5s`}>
                    <ActionIcon variant="light" onClick={() => seekAbs((audioRef.current?.currentTime || 0) - 5)}>
                      <IconPlayerSkipBack size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <ActionIcon
                    variant="light"
                    onClick={() => {
                      if (!audioRef.current) return;
                      if (audioRef.current.paused) {
                        audioRef.current.play(); setIsPlaying(true);
                      } else {
                        audioRef.current.pause(); setIsPlaying(false);
                      }
                    }}
                  >
                    {isPlaying ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />}
                  </ActionIcon>
                  <Tooltip label={t`+5s`}>
                    <ActionIcon variant="light" onClick={() => seekAbs((audioRef.current?.currentTime || 0) + 5)}>
                      <IconPlayerSkipForward size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </>
            )}
          </Stack>
        </Paper>
      )}

      <Stack>
        <Group justify="space-between" align="center">
          <Group gap="xs" align="center">
            <Title order={2}><Trans>Transcript</Trans></Title>
            {isEmptyConversation && (
              <Badge color="red" variant="light"><Trans>Empty</Trans></Badge>
            )}
          </Group>
          <Group gap="sm">
            {(legacyView || hasMergedAudio) && (
            <Switch
              checked={showAudioPlayer}
              onChange={(e) => setShowAudioPlayer(e.currentTarget.checked)}
              label={t`Show audio player`}
            />
            )}
            <Switch
              checked={!legacyView}
              onChange={(e) => setLegacyView(!e.currentTarget.checked)}
              label={
                <Group gap="xs">
                  <Trans>Show timestamps (experimental)</Trans>
                </Group>
              }
            />
            <Tooltip label={t`Download transcript`}>
              <ActionIcon onClick={openDownload} size="md" variant="subtle" color="gray">
                <IconDownload size={20} />
              </ActionIcon>
            </Tooltip>
            <CopyButton value={transcriptQuery.data ?? ""}>
              {({ copied, copy }) => (
                <Tooltip label={t`Copy transcript`}>
                  <ActionIcon
                    size="md"
                    variant="subtle"
                    color="gray"
                    loading={transcriptQuery.isLoading}
                    onClick={copy}
                  >
                    {!copied ? <IconCopy size={20} /> : <IconCheck size={20} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
            <Tooltip label={t`Retranscribe conversation`}>
              <ActionIcon onClick={openRetranscribe} size="md" variant="subtle" color="gray">
                <IconRefresh size={20} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>

        {/* Download Modal */}
        <Modal opened={downloadOpened} onClose={closeDownload} title={t`Download Transcript Options`}>
          <Stack>
            <TextInput
              label={t`Custom Filename`}
              placeholder="ConversationTitle-Email.md"
              value={filename}
              onChange={(e) => setFilename(e.currentTarget.value)}
            />
            <Button
              onClick={() => {
                handleDownloadTranscript(filename);
                closeDownload();
              }}
              rightSection={<IconDownload />}
            >
              <Trans>Download</Trans>
            </Button>
          </Stack>
        </Modal>

        {/* Retranscribe Modal */}
        <Modal
          opened={retranscribeOpened}
          onClose={closeRetranscribe}
          title={
            <Group gap="xs">
              <Text>{t`Retranscribe Conversation`}</Text>
              <Badge color="blue" size="sm"><Trans>Experimental</Trans></Badge>
            </Group>
          }
        >
          {retranscribeMutation.isPending ? (
            <Stack>
              <Alert title={t`Processing your retranscription request...`}>
                <Trans>
                  Please wait while we process your retranscription request. You
                  will be redirected to the new conversation when ready.
                </Trans>
              </Alert>
              <ExponentialProgress expectedDuration={30} isLoading={true} />
            </Stack>
          ) : (
            <Stack>
              <Alert>
                <Trans>
                  This will create a new conversation with the same audio but a
                  fresh transcription. The original conversation will remain
                  unchanged.
                </Trans>
              </Alert>
              <TextInput
                label={t`New Conversation Name`}
                placeholder={t`Enter a name for the new conversation`}
                value={newConversationName}
                onChange={(e) => setNewConversationName(e.currentTarget.value)}
                required
              />
              <Button
                onClick={handleRetranscribe}
                rightSection={<IconRefresh size="1rem" />}
                disabled={!newConversationName.trim()}
              >
                <Trans>Retranscribe</Trans>
              </Button>
            </Stack>
          )}
        </Modal>

        {/* Chunks */}
        <Stack>
          {!hasValidTranscripts && !conversationQuery.data?.is_finished ? (
            <Alert icon={<IconAlertCircle size={16} />} title={t`Transcription in progress...`} color="gray">
              <Trans>Your conversation is currently being transcribed. Please check back in a few moments.</Trans>
            </Alert>
          ) : !hasValidTranscripts && conversationQuery.data?.is_finished ? (
            <Alert icon={<IconAlertCircle size={16} />} title={t`No Transcript Available`} color="gray">
              <Trans>No transcript exists for this conversation yet. Please check back later.</Trans>
            </Alert>
          ) : hasMergedAudio ? (
              <ConversationChunkAudioTranscript
                chunk={{
                  conversation_id: conversationId ?? "",
                  id: 'merged-chunk',
                  path: '', // Not needed
                  timestamp: allChunks[0]?.timestamp ?? new Date().toISOString(),
                  transcript: transcriptQuery.data ?? '',
                  diarization: mergedDiarization,
                  error: null,
                }}
                showAudioPlayer={false} // Global player is used
                isActive={true}
                onSeek={seekAbs}
                currentTime={currentTime}
                chunkOffsetStart={0} // Offsets are pre-calculated in mergedSegments
                legacyView={legacyView}
                precomputedSegments={mergedSegments}
              />
            ) : (
            allChunks.map((chunk, index, array) => {
              const isLast = index === array.length - 1;
              const o = offsets[chunk.id];
              const segs = chunkSegments[chunk.id] ?? [];
              return (
                <div key={chunk.id} ref={isLast ? loadMoreRef : undefined}>
                  <ConversationChunkAudioTranscript
                    chunk={{
                      conversation_id: chunk.conversation_id as string,
                      id: chunk.id,
                      path: chunk.path ?? "",
                      timestamp: chunk.timestamp ?? "",
                      transcript: chunk.transcript ?? "",
                      error: chunk.error ?? "",
                      diarization: chunk.diarization ?? null,
                    }}
                    showAudioPlayer={legacyView && showAudioPlayer && !hasMergedAudio}
                    isActive={activeChunkId === chunk.id}
                    onSeek={hasMergedAudio ? seekAbs : undefined}
                    currentTime={hasMergedAudio ? currentTime : undefined}
                    chunkOffsetStart={hasMergedAudio && o ? o.start : 0}
                    legacyView={legacyView}
                    precomputedSegments={segs}
                  />
                </div>
              );
            })
          )}
          {isFetchingNextPage && !hasMergedAudio && (
            <Stack>
              {[0, 1].map((i) => (
                <Skeleton key={i} height={200} />
              ))}
            </Stack>
          )}
        </Stack>
      </Stack>
    </Stack>
  );
};
