#!/usr/bin/env bash
# Packs both libraries and proves the packages work outside this repository (TASKS R-1). Each package goes into a
# new, empty project, which runs the quickstart sample against the installed package; the TypeScript example is also
# type-checked against the installed types.
# Run from the repository root (needs Node 22+, the .NET 10 SDK and network access for the TypeScript compiler):
#   bash .github/scripts/check-packages.sh [folder for the packages]
set -euo pipefail

root=$(pwd)
out=${1:-$(mktemp -d)}
mkdir -p "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d)
export NUGET_PACKAGES="$work/nuget-cache" # an empty package cache, so an older local build of the same version is not used

echo "== npm package"
(cd js && npm pack --loglevel=warn --pack-destination "$out" > /dev/null)
tgz=$(ls "$out"/smithsoft-studios-jazmin-*.tgz)
mkdir "$work/npm" && cd "$work/npm"
npm init -y > /dev/null
npm pkg set type=module
npm install --no-audit --no-fund "$tgz" > /dev/null
sed "s#'../src/index.js'#'@smithsoft-studios/jazmin'#" "$root/js/examples/quickstart.mjs" > quickstart.mjs
node quickstart.mjs > /dev/null
node --input-type=module -e "await import('@smithsoft-studios/jazmin/browser'); if (typeof JazminBrowser.open !== 'function') throw new Error('@smithsoft-studios/jazmin/browser did not load');"
npx --no-install jazmin --help > /dev/null # the command-line tool is installed with the package
npm install --no-audit --no-fund --no-save typescript@5 @types/node@22 > /dev/null
cp "$root/js/examples/typescript/quickstart.ts" .
printf '{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true, "noEmit": true, "types": ["node"] }, "include": ["quickstart.ts"] }\n' > tsconfig.json
npx tsc -p .
echo "   $(basename "$tgz"): installs, the quickstart runs, @smithsoft-studios/jazmin/browser loads, the jazmin command runs, the types check"

echo "== NuGet package"
cd "$root/dotnet"
dotnet pack src/Jazmin/Jazmin.csproj --configuration Release --output "$out" -p:ContinuousIntegrationBuild=true > /dev/null
nupkg=$(ls "$out"/Jazmin.*.nupkg)
version=$(basename "$nupkg" .nupkg)
version=${version#Jazmin.}
mkdir "$work/CleanApp" && cd "$work/CleanApp"
dotnet new console --framework net10.0 > /dev/null
dotnet add package Jazmin --version "$version" --source "$out" > /dev/null
cp "$root/dotnet/samples/Jazmin.Samples/Program.cs" Program.cs
dotnet run --configuration Release > /dev/null
echo "   $(basename "$nupkg"): installs and the sample runs"

rm -rf "$work"
echo "Packages in $out"
