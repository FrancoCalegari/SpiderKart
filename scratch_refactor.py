import re

with open('public/js/game-engine.js', 'r', encoding='utf-8') as f:
    code = f.read()

# I will back up the original code first
with open('public/js/game-engine.js.bak', 'w', encoding='utf-8') as f:
    f.write(code)

print("Backup created.")
