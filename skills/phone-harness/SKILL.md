# Phone Harness

Control a physical Android device over authorised USB debugging. This is device
control, not an Android companion app — the phone must be plugged in and must have
already accepted this computer's debugging key.

## Before you start

1. Enable Developer options and USB debugging on the phone.
2. Plug it in and accept the "Allow USB debugging?" prompt. Tick "always allow from
   this computer" only if you mean it.
3. Confirm the device is visible before doing anything else. If `adb devices` shows
   `unauthorized`, the prompt was not accepted and nothing below will work.

## Working rules

- Take a screenshot before and after any action that changes state. You cannot see the
  screen; assuming a tap landed is how you end up three screens deep in the wrong app.
- Prefer text entry over coordinate taps where an element has a resource id.
- Never accept a payment, send a message, or delete data without asking first. A
  phone is somebody's actual phone.
- If the screen looks unfamiliar, stop and describe what you see rather than tapping
  to find your way out.
- Coordinates are device-specific. Re-derive them from the current screenshot every
  time; do not reuse coordinates from earlier in the conversation.

## What to hand back

When you finish, say what you changed on the device, what you left open, and anything
you noticed but did not touch.
