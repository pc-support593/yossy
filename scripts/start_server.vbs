Set WshShell = CreateObject("WScript.Shell")
projectDir = "C:\Users\y-honda\Desktop\claude\webinputsystem\claude-code-team"
WshShell.CurrentDirectory = projectDir
WshShell.Run "cmd /c if not exist data mkdir data & node src\server.js >> data\server.log 2>&1", 0, False
