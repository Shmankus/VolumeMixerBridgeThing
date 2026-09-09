/**
 * @fileoverview This file handles input events for the main app, 
 * including scroll wheel events for volume and debugging on hardware events.
 * 
 * @module inputHandler
 * @requires react
 * @requires serverSenders
 * 
 */

import { BridgethingClient } from "@bridgething/client";
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { sendServerLog } from "./serverSenders";
type AppState = Record<string, { volume: number; muted: boolean }>;

export function scrollHandler(selectedApp: string | null, showingDemoApps: boolean, setApps: React.Dispatch<React.SetStateAction<AppState>>, client: BridgethingClient, setIsScrollActive: React.Dispatch<React.SetStateAction<boolean>>) {


    const volumeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Scroll wheel listener for volume control, with a 300ms debounce to send final volume to server after scrolling stops
    useEffect(() => {
        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();

            if (!selectedApp || showingDemoApps) return;

            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
            if (Math.abs(delta) < 1) return;

            const step = delta > 0 ? 5 : -5;

            // Mark scroll active
            setIsScrollActive(true);

            let targetVolume = 0;

            // Updates the volume state immediately for UI feedback, but does not send to server yet
            setApps((previous) => {
                const currentApp = previous[selectedApp];
                if (!currentApp) return previous;

                const currentVol = currentApp.volume ?? 0;
                targetVolume = Math.min(Math.max(currentVol + step, 0), 100);

                return {
                    ...previous,
                    [selectedApp]: { ...currentApp, volume: targetVolume },
                };
            });
            // Clear any existing timeout
            if (volumeTimeoutRef.current) {
                clearTimeout(volumeTimeoutRef.current);
            }

            // Set a new timeout to send the final volume after 300ms of no scrolling
            volumeTimeoutRef.current = setTimeout(() => {
                console.log("Scrolling finished. Sending final volume:", targetVolume);

                // Dispatch final volume to server
                client.forward.json({
                    type: "volume:set",
                    appName: selectedApp,
                    volume: targetVolume,
                });

                // Mark scroll as inactive
                setIsScrollActive(false);
                volumeTimeoutRef.current = null;
            }, 300);
        };


        const options: AddEventListenerOptions = { passive: false };
        window.addEventListener("wheel", handleWheel, options);

        return () => {
            window.removeEventListener("wheel", handleWheel);
            if (volumeTimeoutRef.current) {
                clearTimeout(volumeTimeoutRef.current);
            }
        };
    }, [selectedApp, showingDemoApps]);
}


export function selectionHandler(
  client: BridgethingClient,
  apps: Record<string, { volume?: number }>,
  demoApps: Record<string, { volume: number; muted: boolean }>,
  setSelectedApp: Dispatch<SetStateAction<string>>
) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = Number(event.key);

      if (!Number.isInteger(key) || key < 1) return;

      const source = Object.keys(apps).length > 0 ? apps : demoApps; // gets the source of apps to select from, either the real apps or demo apps if no real apps are present
      const appNames = Object.keys(source); // gets the names of the apps in the source
      const appName = appNames[key - 1];

      if (!appName) return;

      setSelectedApp(appName);
      sendServerLog(client, `[KEY SELECTION] Selected app: ${appName}`);
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [apps, demoApps, client, setSelectedApp]);
}

export function useDebugHardwareEvents(client: BridgethingClient) {
    useEffect(() => {
        // 1. Wheel / Rotary events

        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            sendServerLog(client, "[HARDWARE EVENT: WHEEL]" + JSON.stringify({
                deltaX: event.deltaX,
                deltaY: event.deltaY,
                deltaZ: event.deltaZ,
                deltaMode: event.deltaMode,
                target: event.target,
            }));
        };

        // 2. Keyboard / Hardkey events
        const handleKeyDown = (event: KeyboardEvent) => {
            sendServerLog(client, "[HARDWARE EVENT: KEYDOWN]" + JSON.stringify({
                key: event.key,
                code: event.code,
                keyCode: event.keyCode,
                repeat: event.repeat,
                target: event.target,
            }));
        };

        // 3. Touch / Pointer events
        const handlePointerDown = (event: PointerEvent) => {
            sendServerLog(client, "[HARDWARE EVENT: POINTER]" + JSON.stringify({
                pointerType: event.pointerType,
                x: event.clientX,
                y: event.clientY,
                target: event.target,
            }));
        };

        const options: AddEventListenerOptions = { passive: false };

        window.addEventListener("wheel", handleWheel, options);
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("pointerdown", handlePointerDown);

        return () => {
            window.removeEventListener("wheel", handleWheel, options);
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("pointerdown", handlePointerDown);
        };
    }, []);
}
