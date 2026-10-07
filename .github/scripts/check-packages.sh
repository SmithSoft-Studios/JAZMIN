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

echo "== NuGet packages"
cd "$root/dotnet"
dotnet pack src/Jazmin/Jazmin.csproj --configuration Release --output "$out" -p:ContinuousIntegrationBuild=true > /dev/null
dotnet pack src/Jazmin.AspNetCore/Jazmin.AspNetCore.csproj --configuration Release --output "$out" -p:ContinuousIntegrationBuild=true > /dev/null
nupkg=$(ls "$out"/Jazmin.[0-9]*.nupkg)
version=$(basename "$nupkg" .nupkg)
version=${version#Jazmin.}
mkdir "$work/CleanApp" && cd "$work/CleanApp"
dotnet new console --framework net10.0 > /dev/null
dotnet add package Jazmin --version "$version" --source "$out" > /dev/null
cp "$root/dotnet/samples/Jazmin.Samples/Program.cs" Program.cs
dotnet run --configuration Release > /dev/null
echo "   $(basename "$nupkg"): installs and the sample runs"

# Jazmin.AspNetCore: a clean web app maps a file's embedded files and is served a byte range of one.
aspnetcore=$(ls "$out"/Jazmin.AspNetCore.[0-9]*.nupkg)
mkdir "$work/CleanWeb" && cd "$work/CleanWeb"
dotnet new web --framework net10.0 > /dev/null
dotnet add package Jazmin.AspNetCore --version "$version" --source "$out" > /dev/null
cat > Program.cs <<'CS'
using Jazmin;
using Jazmin.AspNetCore;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;

var path = Path.Combine(Path.GetTempPath(), $"jazmin-check-{Guid.NewGuid():N}.jzm");
var key = JazminKey.Generate();
var bytes = Enumerable.Range(0, 300_000).Select(i => (byte)i).ToArray();
using (var writer = JazminWriter.Create(path, [new JazminColumn("n", JazminType.Int)], new JazminWriteOptions { Key = key, Files = [new JazminFileInput("a.bin", bytes)] }))
    writer.WriteValues([1L]);
var builder = WebApplication.CreateSlimBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:0");
var app = builder.Build();
app.MapJazminFiles("/files/{id}", _ => ValueTask.FromResult<JazminFileSource?>(new JazminFileSource(path, new JazminReadOptions { Key = key })));
await app.StartAsync();
var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
using var http = new HttpClient { BaseAddress = new Uri(address) };
var request = new HttpRequestMessage(HttpMethod.Get, "/files/x/a.bin");
request.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(1000, 1009);
var response = await http.SendAsync(request);
var part = await response.Content.ReadAsByteArrayAsync();
await app.StopAsync();
File.Delete(path);
if ((int)response.StatusCode != 206 || !part.SequenceEqual(bytes[1000..1010])) throw new Exception($"Expected bytes 1000-1009 (206), got {(int)response.StatusCode} with {part.Length} bytes");
CS
dotnet run --configuration Release > /dev/null
echo "   $(basename "$aspnetcore"): installs, and a web app serves a byte range of an embedded file"

rm -rf "$work"
echo "Packages in $out"
