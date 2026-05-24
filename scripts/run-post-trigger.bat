@echo off
set "NODE_PATH=C:\Program Files\nodejs"
"%NODE_PATH%\node.exe" "C:\Users\User\testnews\scripts\trigger-post.js" >> "C:\Users\User\testnews\logs\post-trigger.log" 2>&1
