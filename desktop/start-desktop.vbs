Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = "D:\work\Ace\desktop"
ws.Run "cmd /c pnpm start", 0, False
