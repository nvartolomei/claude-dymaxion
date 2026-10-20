# claude-dymaxion

Buckminster Fuller's Dymaxion sleep schedule, now for Claude Code. Dymaxion sleep is [polyphasic](https://en.wikipedia.org/wiki/Polyphasic_sleep): instead of one long night, you take four 30-minute naps a day, one every six hours. Fuller gave it up because his business associates kept normal hours. Claude doesn't have that problem.

This plugin puts Claude to sleep when your quota runs low and wakes it up once the quota resets. You can also pause Claude yourself with `/pause`. It stops at the next step without adding anything to the conversation, and stays paused until you send a prompt.

## Use

| Command | What it does |
| --- | --- |
| `/pause limit 90 resume` | Pauses this session when the 5-hour or weekly window reaches 90%, and resumes on its own when the window resets. |
| `/pause limit 90` | Same, but stays paused until you send a prompt. |
| `/pause limit off` | Turns off the quota pause for this session. |
| `/pause until-reset [prompt]` | Pauses until the most-used quota window resets, then sends `prompt`, or the resume prompt below. Use it when a session waits on you at the limit. |
| `/pause` | Lets the running tool finish, then stops before the next model request or tool call. Claude stays paused until you send a prompt; notices from background agents wait until then. |
| `/pause compact` | Pauses, then compacts the conversation while the prompt cache is warm. |
| `/pause status` | Shows whether the session is paused, its quota limit, and how much of each quota window is used. |

## Install

Requires a Claude Code version that supports plugin hook modules. Tested with 2.1.299 and 2.1.303.

In Claude Code:

```
/plugin install dymaxion --marketplace nvartolomei/claude-dymaxion
```

From a shell:

```
claude plugin install dymaxion --marketplace nvartolomei/claude-dymaxion
```

In the desktop app: click + next to the prompt box and choose Plugins. Click Add marketplace, enter `nvartolomei/claude-dymaxion`, then click Add plugin.

## Settings

Set these with `/plugin configure dymaxion@claude-dymaxion` to apply them to every session:

| Setting | Default | What it does |
| --- | --- | --- |
| `quotaLimit` | 0 (off) | Pauses when a quota window reaches this percent. |
| `quotaResume` | Off | Resumes when the window that caused the pause resets. |

## Notes

- Claude Code resumes only on a prompt, so an automatic resume sends one: the prompt you gave `/pause until-reset`, or "The quota window has reset. Continue where you left off." A plain `/pause` never resumes on its own.
- The status line under the prompt shows `pausing` or `paused`, `paused until <time>` when the pause resumes on its own, and `pauses at 90%, resumes at reset` while a quota limit that resumes is on.
- Only the main conversation pauses. Running subagents continue until they finish.
- If you resume a session yourself, Claude works past the limit until that window resets, and any scheduled resume is dropped. The settings stay on: the next time the window reaches the limit, the session pauses and resumes as before.
