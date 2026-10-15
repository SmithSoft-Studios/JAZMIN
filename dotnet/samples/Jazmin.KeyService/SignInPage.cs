using System.Net;
using System.Text.Json;

namespace Jazmin.KeyService;

/// <summary>
/// The page a viewer opens to unlock a stored file (spec 6.8.2): <c>GET /jazmin/unlock?jazmin=unlock&amp;file=…&amp;lock=…&amp;origin=…</c>.
/// The person signs in (here: a user id, as the rest of this sample) and gives the code from their authenticator app;
/// the page asks <c>POST /unlock-lock</c> for the token and posts it to the viewer that opened it, but only to a viewer
/// origin the service allows (Jazmin__AllowedOrigins; "null" for a viewer opened from disk, for demos on your own
/// computer). A token opens nothing without a key that sees the locked file.
/// </summary>
public static class SignInPage
{
    public static string Html(string origin, IReadOnlyCollection<string> allowedOrigins)
    {
        if (!allowedOrigins.Contains(origin, StringComparer.Ordinal))
        {
            return Page($"<p class=\"error\">The viewer at <code>{WebUtility.HtmlEncode(origin)}</code> isn't one this service answers. "
                + "Its administrator can add it to Jazmin__AllowedOrigins.</p>", script: "");
        }
        // The origin goes into the script as a JSON string: no quote or tag in it can end the script early.
        var target = JsonSerializer.Serialize(origin == "null" ? "*" : origin);
        return Page("""
            <p>Unlock <b id="lock"></b> in file <code id="file"></code>.</p>
            <form id="form">
              <label for="user">User</label><input id="user" autocomplete="username" required>
              <label for="code">Code from your authenticator app</label>
              <input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required>
              <button type="submit">Unlock</button>
            </form>
            <p id="status" role="status"></p>
            """, $$"""
            const q = new URLSearchParams(location.search);
            const file = q.get('file') || '';
            const lock = q.get('lock') || '';
            document.getElementById('file').textContent = file;
            document.getElementById('lock').textContent = lock;
            const status = (text) => { document.getElementById('status').textContent = text; };
            document.getElementById('form').addEventListener('submit', async (event) => {
              event.preventDefault();
              if (!window.opener) return status('Open this page from the viewer: it has no viewer to answer.');
              status('Checking…');
              const response = await fetch('/unlock-lock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-User-Id': document.getElementById('user').value },
                body: JSON.stringify({ fileId: file, lockId: lock, code: document.getElementById('code').value }),
              });
              if (!response.ok) {
                return status({ 401: 'That user or code is not right.', 403: 'This lock is not yours to open.', 404: "This service doesn't know that file or lock.",
                  429: 'Too many wrong codes: try again later.' }[response.status] || `The service couldn't answer (${response.status}).`);
              }
              const { token } = await response.json();
              window.opener.postMessage({ type: 'jazmin:file-unlock', file, lock, token }, {{target}});
              status('Unlocked: you can close this window.');
              setTimeout(() => window.close(), 800);
            });
            """);
    }

    private static string Page(string body, string script) => $$"""
        <!doctype html>
        <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Unlock a file</title>
        <style>
          :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
          body { max-width: 420px; margin: 32px auto; padding: 0 16px; }
          label { display: block; margin: 12px 0 4px; font-weight: 600; }
          input { width: 100%; box-sizing: border-box; padding: 9px 11px; border-radius: 8px; border: 1px solid #8888; font: inherit; }
          button { margin-top: 16px; padding: 9px 16px; border-radius: 8px; border: 0; background: #2563eb; color: #fff; font: inherit; }
          .error { color: #c0392b; }
        </style></head>
        <body><h1>Unlock a file</h1>
        {{body}}
        <script>{{script}}</script></body></html>
        """;
}
