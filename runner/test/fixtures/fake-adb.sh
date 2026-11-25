#!/bin/sh
# Test double for adb. Behaviour is driven by files in $FAKE_STATE (connected device list).
S="${FAKE_STATE:?}"
[ "$1" = "-s" ] && { SERIAL="$2"; shift 2; }
case "$1" in
  devices)
    echo "List of devices attached"
    [ -f "$S/connected" ] && while read -r d; do printf '%s\tdevice product:panther model:Pixel_7 device:panther transport_id:2\n' "$d"; done < "$S/connected"
    exit 0 ;;
  connect)
    case "$2" in 10.99.*) echo "failed to connect to '$2': Connection refused"; exit 1 ;; esac
    grep -qx "$2" "$S/connected" 2>/dev/null || echo "$2" >> "$S/connected"
    echo "connected to $2"; exit 0 ;;
  disconnect)
    [ -f "$S/connected" ] && grep -vx "$2" "$S/connected" > "$S/c.tmp"; mv "$S/c.tmp" "$S/connected" 2>/dev/null
    echo "disconnected $2"; exit 0 ;;
  kill-server|start-server) exit 0 ;;
  version) echo "Android Debug Bridge version 1.0.41"; exit 0 ;;
  install) echo "Performing Streamed Install"; echo "Success"; echo "$SERIAL $*" >> "$S/installs"; exit 0 ;;
  exec-out) printf '\211PNG\r\n\032\nfakepng'; exit 0 ;;
  logcat)
    [ "$2" = "-c" ] && exit 0
    echo "11-25 10:00:00.100  100  100 I MyTag   : hello world"
    echo "11-25 10:00:00.200  100  100 D Noise   : debug noise"
    echo "11-25 10:00:01.123  100  100 E AndroidRuntime: FATAL EXCEPTION: main"
    echo "11-25 10:00:01.124  100  100 E AndroidRuntime: java.lang.IllegalStateException: boom"
    exec sleep 60 ;;
  shell)
    shift
    case "$1" in
      monkey) echo "Events injected: 1" ;;
      am) exit 0 ;;
      pm) echo "Success" ;;
      pidof) echo "4242" ;;
    esac
    exit 0 ;;
esac
echo "fake adb: unsupported $*" >&2; exit 1
