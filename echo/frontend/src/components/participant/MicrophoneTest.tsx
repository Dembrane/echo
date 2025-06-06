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
import { IconMicrophone } from "@tabler/icons-react";
import { useSearchParams } from "react-router-dom";

interface MicrophoneTestProps {
  onContinue: (deviceId: string) => void;
}

const MicrophoneTest: React.FC<MicrophoneTestProps> = ({ onContinue }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [isLoadingDevices, setIsLoadingDevices] = useState(true);
  const [level, setLevel] = useState<number>(0);
  const SILENCE_THRESHOLD = 2;
  const UPDATE_INTERVAL = 300; // ms between visual updates
  const lastUpdateRef = useRef<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [micAccessGranted, setMicAccessGranted] = useState(false);
  const [micAccessDenied, setMicAccessDenied] = useState(false);
  const [isMicTestSuccessful, setIsMicTestSuccessful] = useState(false);
  const [hasBeenSuccessful, setHasBeenSuccessful] = useState(false);
  const isMicSuccessRef = useRef(false);
  const displayLevel = Math.min(Math.sqrt(level / 255) * 100, 100);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);

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

        // Mark that we have mic access
        setMicAccessGranted(true);
        setMicAccessDenied(false);
      } catch (error) {
        console.error(
          "Failed to get microphone permission or enumerate devices:",
          error,
        );
        setMicAccessDenied(true);
        setErrorMessage(
          "Microphone permission is required. Please allow access to proceed.",
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
      if (analyserRef.current && dataArrayRef.current) {
        // Get time-domain data for quick RMS level estimation (more performant)
        analyserRef.current.getByteTimeDomainData(dataArrayRef.current);
        let sumSq = 0;
        for (let i = 0; i < dataArrayRef.current.length; i++) {
          const centered = dataArrayRef.current[i] - 128;
          sumSq += centered * centered;
        }
        const rms = Math.sqrt(sumSq / dataArrayRef.current.length);
        const avg = rms * 2; // approx scale 0-255

        // Throttle UI update
        const now = performance.now();
        if (now - lastUpdateRef.current >= UPDATE_INTERVAL) {
          lastUpdateRef.current = now;
          // Only update state if change is noticeable (≥1%) to avoid unnecessary re-renders
          setLevel((prev) => {
            const newLevel = avg;
            const prevDisplay = Math.min(Math.sqrt(prev / 255) * 100, 100);
            const newDisplay = Math.min(Math.sqrt(newLevel / 255) * 100, 100);
            return Math.abs(newDisplay - prevDisplay) >= 1 ? newLevel : prev;
          });
        }

        // Voice / silence detection logic
        if (avg > SILENCE_THRESHOLD) {
          silenceStartRef.current = null;
          if (!isMicSuccessRef.current) {
            setIsMicTestSuccessful(true);
            isMicSuccessRef.current = true;
            setHasBeenSuccessful(true);
          }
        } else {
          if (silenceStartRef.current === null) {
            silenceStartRef.current = now;
          } else if (
            now - silenceStartRef.current > 2000 &&
            isMicSuccessRef.current
          ) {
            setIsMicTestSuccessful(false);
            isMicSuccessRef.current = false;
          }
        }
      }
      animationFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  // setup stream, analyser when device changes
  useEffect(() => {
    const setup = async () => {
      if (!selectedDeviceId) return;

      // Reset success state when device changes
      setIsMicTestSuccessful(false);
      setHasBeenSuccessful(false);
      isMicSuccessRef.current = false;
      silenceStartRef.current = null;

      // cleanup old
      stopAnalyzer();
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
        setMicAccessGranted(true);
        setMicAccessDenied(false);

        // setup audio analyser for levels and visualization (improved pattern)
        const audioCtx = new AudioContext();
        audioContextRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();

        // Set up analyzer with good balance of detail and performance
        analyser.fftSize = 1024; // smaller FFT size for lower CPU cost
        analyser.smoothingTimeConstant = 0.8;

        source.connect(analyser);
        analyserRef.current = analyser;
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        dataArrayRef.current = dataArray;

        startAnalyzer();
      } catch (err) {
        console.error("Error setting up microphone:", err);
        setMicAccessDenied(true);
        setErrorMessage(
          "Microphone permission is required. Please allow access to proceed.",
        );
      }
    };
    setup();

    return () => {
      stopAnalyzer();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, [selectedDeviceId]);

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

          <Select
            className="w-full text-start"
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
            color={level < SILENCE_THRESHOLD ? "yellow" : "blue"}
            className="-mt-2 mb-4 w-full"
          />

          {/* Show error or permission prompt */}
          {!micAccessGranted && !isLoadingDevices && !micAccessDenied && (
            <Alert color="yellow" className="w-full text-start">
              <Trans>Please allow microphone access to start the test.</Trans>
            </Alert>
          )}

          {errorMessage && (
            <Alert color="red" className="w-full text-start">
              {errorMessage}
            </Alert>
          )}
          {isLoadingDevices && (
            <Alert color="blue" className="w-full text-start">
              <Trans>
                Requesting microphone access to detect available devices...
              </Trans>
            </Alert>
          )}

          {/* Real-time feedback alerts - only show after mic access granted */}
          {micAccessGranted &&
            (isMicTestSuccessful ? (
              <Alert color="green" className="w-full text-start">
                <Trans>Everything looks good – you can continue.</Trans>
              </Alert>
            ) : (
              <Alert color="yellow" className="w-full text-start">
                <Trans>
                  We cannot hear you. Please try changing your microphone or get
                  a little closer to the device.
                </Trans>
              </Alert>
            ))}

          <div className="mt-8 flex w-full flex-wrap items-start gap-2">
            <div className="w-full flex-1 flex-grow">
              <Button
                onClick={handleContinue}
                variant="outline"
                className="w-full"
                fullWidth
                disabled={!hasBeenSuccessful}
              >
                <Trans>Continue</Trans>
              </Button>
            </div>
            <Button onClick={handleContinue} variant="subtle" className="">
              <Trans>Skip</Trans>
            </Button>
          </div>
        </Stack>
      </Box>
    </div>
  );
};

export default MicrophoneTest;
