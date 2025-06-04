import React, { useEffect, useState, useRef } from "react";
import { Trans } from "@lingui/react/macro";
import {
  Box,
  Title,
  Text,
  Select,
  Progress,
  Button,
  Alert,
  Stack,
} from "@mantine/core";
import { IconInfoCircle, IconMicrophone } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { getSupportedMimeType } from "@/hooks/useChunkedAudioRecorder";
import { useSearchParams } from "react-router-dom";
// import { Howl } from "howler"; // Removed - using simple HTML5 audio like reference

interface MicrophoneTestProps {
  onContinue: (deviceId: string) => void;
}

const MicrophoneTest: React.FC<MicrophoneTestProps> = ({ onContinue }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [isLoadingDevices, setIsLoadingDevices] = useState(true);
  const [chunks, setChunks] = useState<Blob[]>([]);
  const [level, setLevel] = useState<number>(0);
  const [showTip, setShowTip] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const SILENCE_THRESHOLD = 5;
  const UPDATE_INTERVAL = 100; // ms between visual updates
  const lastUpdateRef = useRef<number>(0);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [isMicTestSuccessful, setIsMicTestSuccessful] = useState(false);
  // const [showTipTimeout, setShowTipTimeout] = useState(false); // Commented out per request
  const displayLevel = Math.min(Math.sqrt(level / 255) * 100, 100);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Request permission and enumerate audio input devices
  useEffect(() => {
    const initializeDevices = async () => {
      setIsLoadingDevices(true);
      try {
        // First request microphone permission to get device labels
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

        // Now enumerate devices - this will include labels
        if (navigator.mediaDevices?.enumerateDevices) {
          const all = await navigator.mediaDevices.enumerateDevices();
          const inputs = all.filter((d) => d.kind === "audioinput");
          setDevices(inputs);

          // Check if device ID is in search params
          const savedDeviceId = searchParams.get("micDeviceId");
          if (
            savedDeviceId &&
            inputs.some((d) => d.deviceId === savedDeviceId)
          ) {
            setSelectedDeviceId(savedDeviceId);
          } else if (inputs.length > 0 && !selectedDeviceId) {
            setSelectedDeviceId(inputs[0].deviceId);
          }
        }

        // Stop the temporary stream
        stream.getTracks().forEach((track) => track.stop());
      } catch (error) {
        console.error(
          "Failed to get microphone permission or enumerate devices:",
          error,
        );
        setPlaybackError(
          "Microphone permission is required. Please allow access and refresh the page.",
        );
      } finally {
        setIsLoadingDevices(false);
      }
    };

    initializeDevices();
  }, [searchParams]);

  // Save device ID to search params when it changes
  useEffect(() => {
    if (selectedDeviceId) {
      const newSearchParams = new URLSearchParams(searchParams);
      newSearchParams.set("micDeviceId", selectedDeviceId);
      setSearchParams(newSearchParams, { replace: true });
    }
  }, [selectedDeviceId, searchParams, setSearchParams]);

  const stopAnalyzer = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  };

  const startAnalyzer = () => {
    const tick = () => {
      if (analyserRef.current && dataArrayRef.current && !isPlaying) {
        // Get frequency data for level calculation
        analyserRef.current.getByteFrequencyData(dataArrayRef.current);
        let sum = 0;
        for (let i = 0; i < dataArrayRef.current.length; i++) {
          sum += dataArrayRef.current[i];
        }
        const avg = sum / dataArrayRef.current.length;
        const now = performance.now();
        if (now - lastUpdateRef.current >= UPDATE_INTERVAL) {
          lastUpdateRef.current = now;
          setLevel(avg);
        }
      }
      animationFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  // setup stream, recorder, analyser when device changes
  useEffect(() => {
    const setup = async () => {
      if (!selectedDeviceId) return;

      // cleanup old
      stopAnalyzer();
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
        recorderRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: selectedDeviceId } },
        });
        streamRef.current = stream;

        // setup MediaRecorder chunking 1s slices (following MDN pattern)
        const mimeType = getSupportedMimeType();
        const recorder = new MediaRecorder(stream, { mimeType });
        recorderRef.current = recorder;

        // Use the pattern from the reference code
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            setChunks((prev) => {
              const next = [...prev, e.data];
              if (next.length > 3) next.shift();
              return next;
            });
          }
        };

        recorder.onstop = () => {
          console.log(
            "MediaRecorder stopped, chunks available:",
            chunks.length,
          );
        };

        recorder.start(1000);

        // setup audio analyser for levels and visualization (improved pattern)
        const audioCtx = new AudioContext();
        audioContextRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();

        // Set up analyzer with good balance of detail and performance
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.8;

        source.connect(analyser);
        analyserRef.current = analyser;
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        dataArrayRef.current = dataArray;

        startAnalyzer();
      } catch (err) {
        console.error("Error setting up microphone:", err);
        setPlaybackError(
          "Failed to access microphone. Please check permissions.",
        );
      }
    };
    setup();

    // const tipTimer = setTimeout(() => setShowTipTimeout(true), 5000); // Commented out per request

    return () => {
      stopAnalyzer();
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      // clearTimeout(tipTimer); // Commented out per request
    };
  }, [selectedDeviceId]);

  // Check for success based on audio level after a short delay
  useEffect(() => {
    const successCheckTimer = setTimeout(() => {
      if (level > SILENCE_THRESHOLD) {
        setIsMicTestSuccessful(true);
      } else {
        setIsMicTestSuccessful(false);
      }
    }, 2000); // Check 2 seconds after level updates
    return () => clearTimeout(successCheckTimer);
  }, [level]);

  const stopRecording = () => {
    // Stop the MediaRecorder properly like in useChunkedAudioRecorder
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
      recorderRef.current = null;
    }

    // Stop the analyzer
    stopAnalyzer();

    // Close audio context and clean up
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Stop all tracks in the stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const handlePlay = () => {
    if (chunks.length === 0) {
      setPlaybackError(
        "No audio recorded yet. Please speak into your microphone.",
      );
      return;
    }

    setPlaybackError(null);
    setIsPlaying(true);

    // Stop recording during playback (following useChunkedAudioRecorder pattern)
    stopRecording();

    // Use reference pattern: simple HTML5 audio with blob URL
    const blob = new Blob(chunks, {
      type: recorderRef.current?.mimeType || "audio/webm",
    });
    const audioURL = URL.createObjectURL(blob);

    if (audioPlayerRef.current) {
      audioPlayerRef.current.src = audioURL;

      audioPlayerRef.current.onended = () => {
        setIsPlaying(false);
        URL.revokeObjectURL(audioURL);
        setPlaybackError(
          "✓ Audio playback successful! Your microphone is working properly.",
        );
      };

      audioPlayerRef.current.onerror = () => {
        console.warn("Audio playback failed");
        setPlaybackError(
          "Audio playback failed, but recording will work fine for the session.",
        );
        setIsPlaying(false);
        URL.revokeObjectURL(audioURL);
      };

      audioPlayerRef.current.play().catch((err) => {
        console.warn("Play failed:", err);
        setPlaybackError(
          "Audio playback failed, but recording will work fine for the session.",
        );
        setIsPlaying(false);
        URL.revokeObjectURL(audioURL);
      });
    }
  };

  const handleContinue = () => {
    // Ensure device ID is saved in search params before continuing
    if (selectedDeviceId) {
      const newSearchParams = new URLSearchParams(searchParams);
      newSearchParams.set("micDeviceId", selectedDeviceId);
      setSearchParams(newSearchParams, { replace: true });
    }
    onContinue(selectedDeviceId);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900 bg-opacity-50">
      <Box className="w-full max-w-[400px] rounded-xl bg-white p-6 text-center shadow-lg">
        <Stack gap="md" className="items-center">
          <IconMicrophone size={64} className="text-blue-500" />
          <Title order={2}>
            <Trans>Let's Make Sure We Can Hear You</Trans>
          </Title>
          <Text color="dimmed" size="sm">
            <Trans>
              We'll test your microphone to ensure the best experience for
              everyone in the session.
            </Trans>
          </Text>

          {isLoadingDevices && (
            <Alert color="blue" className="w-full text-start">
              <Trans>
                Requesting microphone access to detect available devices...
              </Trans>
            </Alert>
          )}

          <Select
            className="w-full"
            label={<Trans>Select your microphone:</Trans>}
            placeholder={
              isLoadingDevices
                ? "Loading microphones..."
                : "Select a microphone"
            }
            disabled={isLoadingDevices}
            data={devices.map((d) => ({
              value: d.deviceId,
              label: d.label || `Microphone ${d.deviceId.slice(0, 8)}...`,
            }))}
            value={selectedDeviceId}
            onChange={(v) => setSelectedDeviceId(v || "")}
          />
          <Text size="sm" className="w-full text-start">
            <Trans>Live audio level:</Trans>
          </Text>
          <Progress
            value={displayLevel}
            color={level < SILENCE_THRESHOLD ? "red" : "blue"}
            className="w-full"
          />

          {/* Show playback error if any */}
          {playbackError && (
            <Alert
              color={playbackError.includes("✓") ? "green" : "red"}
              className="w-full text-start"
            >
              {playbackError}
            </Alert>
          )}

          {/* Tip alert commented out per request */}
          {/* {showTipTimeout && showTip && (
            <Alert
              icon={<IconInfoCircle size={16} />}
              variant="light"
              className="w-full text-start"
              withCloseButton
              onClose={() => setShowTip(false)}
            >
              <Trans>
                Click 'Test Audio Playback' to hear yourself. If you can't, there's a
                good chance we can't either. Find a quiet spot for best results.
              </Trans>
            </Alert>
          )} */}
          <Button
            onClick={handlePlay}
            variant="outline"
            className="w-full"
            disabled={isPlaying || chunks.length === 0}
            loading={isPlaying}
          >
            {isPlaying ? (
              <Trans>Testing Audio...</Trans>
            ) : (
              <Trans>Test Audio Playback</Trans>
            )}
          </Button>
          {/* Hidden audio element for playback - following reference pattern */}
          <audio ref={audioPlayerRef} hidden />

          {/* Silent alert text moved here */}
          {level < SILENCE_THRESHOLD && !isPlaying && (
            <Text size="sm" color="red" className="w-full text-start">
              <Trans>
                Your microphone seems silent. Make sure your mic is connected
                and you're in a quiet spot.
              </Trans>
            </Text>
          )}

          {/* Success indicator */}
          {isMicTestSuccessful && (
            <Stack gap="xs" className="w-full items-center text-green-600">
              {/* Use an actual icon component if available, otherwise keep text */}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="lucide lucide-circle-check"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="m9 12 2 2 4-4" />
              </svg>
              <Text size="md" className="font-semibold">
                <Trans>Looks good!</Trans>
              </Text>
            </Stack>
          )}

          {/* Buttons at the bottom */}
          <div className="mt-auto flex w-full justify-between">
            <Button
              fullWidth
              onClick={handleContinue}
              disabled={!isMicTestSuccessful}
              className="mr-2"
            >
              <Trans>Continue</Trans>
            </Button>
            <Button onClick={handleContinue} variant="subtle">
              <Trans>Skip</Trans>
            </Button>
          </div>
        </Stack>
      </Box>
    </div>
  );
};

export default MicrophoneTest;
