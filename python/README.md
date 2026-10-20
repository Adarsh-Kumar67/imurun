# IMURUN — Python launcher

`pip install imurun` puts a single **`imurun`** command on your PATH.

IMURUN itself is a compiled program, so this package does the one thing a
Python install can do that a downloaded file cannot: pick the right build for
the machine, cache it under `~/.imurun/python`, and run it.

```bash
pip install imurun

imurun                      # the interactive terminal UI
imurun models               # what this machine can run
imurun models install qwen2.5-coder-7b
imurun run "explain this project"
```

The first run downloads the matching standalone executable from the project's
GitHub releases (Windows, Linux and macOS on x64 and arm64). Later runs start
immediately. Nothing is installed system-wide and no administrator rights are
needed.

## Other ways to install

The command is the same everywhere — pick whichever suits your machine:

```bash
npm install -g imurun                                   # needs Bun 1.2+
npm install -g https://github.com/shubham001312/imurun/releases/latest/download/imurun-npm.tgz
pip install imurun                                      # this package
```

Or download a standalone binary from
<https://github.com/shubham001312/imurun/releases/latest> — it needs nothing
else installed.

## What it does

- Installs, manages and runs local language models on your own hardware.
- No cloud dependency, no account, no telemetry.
- Works offline once the model is downloaded.
- MIT licensed, by [ImuTechz](https://imutechz.in) — Shubham Mallick
  (<dev@imutechz.in>).

## License

MIT. See the project repository for the full text.
