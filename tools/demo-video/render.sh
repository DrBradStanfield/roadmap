#!/bin/zsh
cd "$(dirname "$0")"
npx remotion render src/index.ts ImportExplainer out/import-explainer.mp4 --codec h264 --log=error 2>&1 | grep -iv macos
npx remotion render src/index.ts ImportExplainer60 out/import-explainer-60.mp4 --codec h264 --log=error 2>&1 | grep -iv macos
for pair in "0:150" "1:330" "2:760" "3:1150" "6:1900"; do
  b=${pair%%:*}; f=${pair##*:}
  npx remotion still src/index.ts ImportExplainer out/beat$b.png --frame=$f --log=error 2>&1 | grep -iv macos
done
echo RENDER_DONE
