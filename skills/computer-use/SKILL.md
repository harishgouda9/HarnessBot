---
name: computer-use
description: Drive a desktop or browser the user has already placed for this bot. Screenshot, act, then check.
---

# Computer use

Use the computer placement this bot already has — cloud desktop, local VM, this computer, or a browser the user enabled. Do not invent a second way to click. On this computer the tools are `screenshot`, `click`, `move`, `scroll`, `type_text`, `key`, and `open_target`.

## Method

1. Say which placement you are using. If none is ready, stop and ask the user to turn one on. Do not reach for the real keyboard and mouse unless they opted this bot in.
2. Take a screenshot before you act. Describe what is on screen in one line, then do the smallest step that moves the task forward.
3. Take another screenshot after the step. If the screen did not change, do not repeat the same click. Say what you expected and what you saw.
4. Stop before payments, sending messages, deleting files, or anything you cannot undo. Ask first.
5. When you finish, say what changed, what is still open, and anything you noticed but did not touch.

## What not to do

- Do not reuse coordinates from an earlier screenshot. The window may have moved.
- Do not treat a preview as permission. Watching the screen is not the same as being allowed to click.
- Do not keep going once the screen looks unfamiliar. Stop and describe it.
