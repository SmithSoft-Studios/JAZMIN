using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Filing submissions (<see cref="JazminFile.FileSubmission"/>, USER-GUIDE 15.6): the records an access key holder sends
/// back, locked with their submission key, checked and filed into the shared file by its owner. Mirrors
/// js/test/filing-service.test.js and js/test/submissions.test.js.
/// </summary>
public sealed class SubmissionsTests
{
    private static readonly JazminColumn[] Columns =
    [
        new("id", JazminType.String) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("person", JazminType.String) { Nullable = false },
        new("note", JazminType.String),
        new("amount", JazminType.Float),
        new("attachments", JazminType.Json),
    ];
    private static readonly JazminColumn[] BatchColumns = Columns.Select(c => new JazminColumn(c.Name, c.Type) { Nullable = c.Nullable }).ToArray();
    private static readonly DateTimeOffset Expiry = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    private static readonly byte[] Pdf = Encoding.ASCII.GetBytes("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
    private static readonly byte[] Photo = [0xff, 0xd8, 0xff, 0xe0, .. RandomNumberGenerator.GetBytes(300_000)];

    private sealed record Setup(string Dir, string Shared, JazminKey Owner, JazminAccessKey Bob, JazminAccessKey Sally, JazminAccessKey Late, JazminAccessKey Team)
    {
        public JazminSubmissionResult File(JazminAccessKey from, byte[] batch, JazminFileSubmissionOptions? rules = null) =>
            JazminFile.FileSubmission(Shared, batch, new JazminFileSubmissionOptions
            {
                Key = Owner, KeyId = from.Id, ReceivedAt = rules?.ReceivedAt, OnDuplicate = rules?.OnDuplicate ?? JazminOnDuplicate.Replace,
                FileTypes = rules?.FileTypes, MaxFileBytes = rules?.MaxFileBytes ?? 10 * 1024 * 1024, MaxBatchFileBytes = rules?.MaxBatchFileBytes ?? 50 * 1024 * 1024,
                DryRun = rules?.DryRun ?? false,
            });

        /// <summary>A batch as the sender's phone writes it: locked with their submission key, with any files.</summary>
        public byte[] Batch(JazminAccessKey from, IEnumerable<Dictionary<string, object?>> rows, JazminColumn[]? columns = null, IEnumerable<JazminFileInput>? files = null, DateTimeOffset? writtenAt = null)
        {
            var stream = new MemoryStream();
            using (var writer = new JazminWriter(stream, columns ?? BatchColumns, new JazminWriteOptions { Key = Owner.SubmissionKey(from), Files = files?.ToList(), Now = writtenAt }, leaveOpen: true))
                foreach (var row in rows) writer.WriteRow(row);
            return stream.ToArray();
        }

        public List<string> Rows()
        {
            using var reader = JazminReader.Open(Shared, new JazminReadOptions { Key = Owner });
            return reader.Rows().Select(r => $"{r["person"]}:{r["id"]}").OrderBy(s => s, StringComparer.Ordinal).ToList();
        }

        public JazminRow Record(string id)
        {
            using var reader = JazminReader.Open(Shared, new JazminReadOptions { Key = Owner });
            return reader.Find(JazminFilter.Eq("id", id)).Single();
        }
    }

    private static Setup Make(bool hideAmount = false)
    {
        var dir = Directory.CreateTempSubdirectory("jazmin-submissions-").FullName;
        var owner = JazminKey.Generate();
        var (bob, sally, late, team) = (owner.CreateAccessKey(), owner.CreateAccessKey(), owner.CreateAccessKey(), owner.CreateAccessKey());
        var shared = Path.Combine(dir, "shared.jzm");
        var access = new JazminAccessOptions
        {
            PartitionBy = "person",
            Grants =
            [
                new JazminGrant(bob) { Rows = ["P1"], Columns = hideAmount ? ["*"] : null, Label = "Bob" },
                new JazminGrant(sally) { Rows = ["P2"], Label = "Sally" },
                new JazminGrant(late) { Rows = ["P3"], Label = "Late", Expires = Expiry },
                new JazminGrant(team) { Rows = ["P1", "P2"], Label = "Team" },
            ],
        };
        if (hideAmount) access.ColumnGroups["money"] = ["amount"];
        using (var writer = JazminWriter.Create(shared, Columns, new JazminWriteOptions { Key = owner, Access = access, Now = new DateTimeOffset(2025, 1, 1, 0, 0, 0, TimeSpan.Zero) }))
            writer.WriteRow(Row("seed", "P1", "first", 1.0));
        return new Setup(dir, shared, owner, bob, sally, late, team);
    }

    private static Dictionary<string, object?> Row(string id, string? person, string? note = null, double? amount = null, JsonNode? attachments = null) =>
        new() { ["id"] = id, ["person"] = person, ["note"] = note, ["amount"] = amount, ["attachments"] = attachments };

    private static JsonArray Paths(params string[] paths) => new(paths.Select(p => (JsonNode?)p).ToArray());

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static (long, long, long, int, string) Counts(JazminSubmissionResult r) => (r.Filed, r.Updated, r.Duplicates, r.Files, string.Join(",", r.IgnoredColumns));

    private static void Rejected(string pattern, Action file)
    {
        var error = Assert.Throws<JazminSubmissionRejectedException>(file);
        Assert.Matches(pattern, error.Message);
    }

    [Fact]
    public void Rows_go_into_the_senders_own_partition_and_a_batch_sent_twice_is_filed_once()
    {
        var s = Make();
        var batch = s.Batch(s.Bob, [Row("b1", "P1", "visit", 10), Row("b2", "P2", "claims to be Sally", 20), Row("b2", "P1", "twice in one batch", 20)]);
        var dry = s.File(s.Bob, batch, new JazminFileSubmissionOptions { DryRun = true });
        Assert.Equal((2L, 0L, 1L, 0, ""), Counts(dry));
        Assert.Equal(s.Bob.Id, dry.Sender);
        Assert.Equal(["P1:seed"], s.Rows()); // a dry run writes nothing
        Assert.Equal((2L, 0L, 1L, 0, ""), Counts(s.File(s.Bob, batch)));
        Assert.Equal((0L, 0L, 3L, 0, ""), Counts(s.File(s.Bob, batch)));
        Assert.Equal(["P1:b1", "P1:b2", "P1:seed"], s.Rows());
    }

    [Fact]
    public void Forged_revoked_and_ill_fitting_batches_are_rejected_with_the_reason()
    {
        var s = Make();
        var sallys = s.Batch(s.Sally, [Row("s1", "P2", null, 1)]);
        Rejected("doesn't open with key .* submission key", () => s.File(s.Bob, sallys)); // Sally's batch, sent as Bob's
        var leaked = new MemoryStream();
        using (var writer = new JazminWriter(leaked, BatchColumns, new JazminWriteOptions { Key = JazminKey.Generate() }, leaveOpen: true)) writer.WriteRow(Row("x", "P1"));
        Rejected("doesn't open", () => s.File(s.Bob, leaked.ToArray()));
        Rejected("not an access key id", () => JazminFile.FileSubmission(s.Shared, sallys, new JazminFileSubmissionOptions { Key = s.Owner, KeyId = "not-an-id" }));
        Rejected(@"not a readable \.jzm file|doesn't open", () => s.File(s.Bob, Encoding.ASCII.GetBytes("not a jzm file")));
        Rejected("Column 'id' is int in the batch, string in the shared file",
            () => s.File(s.Bob, s.Batch(s.Bob, [new() { ["id"] = 1L, ["person"] = "P1" }], [new("id", JazminType.Int), new("person", JazminType.String)])));
        Rejected("^The batch has no column key [0-9a-f]{16} may write$", () => s.File(s.Bob, s.Batch(s.Bob, [new() { ["mood"] = "x" }], [new("mood", JazminType.String)])));
        JazminFile.RevokeAccess(s.Shared, s.Owner, s.Sally);
        Rejected("has no grant in this file: unknown or revoked", () => s.File(s.Sally, sallys));
        Assert.Equal(["P1:seed"], s.Rows());
    }

    [Fact]
    public void Mistakes_in_the_call_are_validation_errors()
    {
        var s = Make();
        var batch = s.Batch(s.Bob, [Row("b1", "P1")]);
        Assert.Contains("owner key", Assert.Throws<JazminValidationException>(() => JazminFile.FileSubmission(s.Shared, batch, new JazminFileSubmissionOptions { KeyId = s.Bob.Id })).Message);
        Assert.Contains("Unknown file type 'text/html'", Assert.Throws<JazminValidationException>(() => s.File(s.Bob, batch, new JazminFileSubmissionOptions { FileTypes = ["text/html"] })).Message);
        var plain = Path.Combine(s.Dir, "plain.jzm");
        var key = JazminKey.Generate();
        using (var writer = JazminWriter.Create(plain, Columns, new JazminWriteOptions { Key = key })) writer.WriteRow(Row("a", "P1"));
        Assert.Contains("into a shared file", Assert.Throws<JazminValidationException>(() => JazminFile.FileSubmission(plain, batch, new JazminFileSubmissionOptions { Key = key, KeyId = s.Bob.Id })).Message);
        Assert.Equal(["application/pdf", "image/jpeg", "image/png", "image/webp"], JazminFile.SubmissionFileTypes);
    }

    [Fact]
    public void A_key_that_expires_is_filed_only_for_batches_written_and_arrived_before_it_expired()
    {
        var s = Make();
        JazminSubmissionResult Send(string id, DateTimeOffset writtenAt, DateTimeOffset receivedAt) =>
            s.File(s.Late, s.Batch(s.Late, [Row(id, "P3")], writtenAt: writtenAt), new JazminFileSubmissionOptions { ReceivedAt = receivedAt });
        Rejected(@"^The batch arrived at 2026-01-01T00:01:00\.000Z, after key [0-9a-f]{16}'s access expired at 2026-01-01T00:00:00\.000Z$",
            () => Send("l1", Expiry.AddMinutes(-10), Expiry.AddMinutes(1)));
        Rejected(@"^The batch was written at 2026-01-01T00:01:00\.000Z, after key [0-9a-f]{16}'s access expired at 2026-01-01T00:00:00\.000Z$",
            () => Send("l2", Expiry.AddMinutes(1), Expiry.AddMinutes(-1)));
        Assert.Equal((1L, 0L, 0L, 0, ""), Counts(Send("l3", Expiry.AddMinutes(-10), Expiry.AddMinutes(-1))));
        Rejected("has no grant in this file", () => Send("l4", Expiry.AddMinutes(-10), Expiry.AddMinutes(-1))); // that append removed the expired grant
        Assert.Equal(["P1:seed", "P3:l3"], s.Rows());
    }

    [Fact]
    public void Each_records_files_are_stored_once_at_paths_chosen_here_for_the_keys_that_see_its_row()
    {
        var s = Make();
        var batch = s.Batch(s.Bob,
            [Row("b1", "P1", "visit", 1, Paths("visit/receipt.pdf", "visit/photo.jpg")), Row("b2", "P1", "same photo", 2, Paths("visit/photo.jpg")), Row("b3", "P1", "no files", 3)],
            files: [new JazminFileInput("visit/receipt.pdf", Pdf), new JazminFileInput("visit/photo.jpg", Photo) { Type = "text/html" }]); // the type the phone gives is ignored
        Assert.Equal((3L, 0L, 0L, 2, ""), Counts(s.File(s.Bob, batch)));
        Assert.Equal((0L, 0L, 3L, 0, ""), Counts(s.File(s.Bob, batch)));
        var pdfPath = $"attachments/{s.Bob.Id}/{Sha(Pdf)}.pdf";
        var photoPath = $"attachments/{s.Bob.Id}/{Sha(Photo)}.jpg";
        JazminFile.Compact(s.Shared, s.Owner, regroup: true); // files stay through compaction
        Assert.Equal(
            $$"""[{"path":"{{pdfPath}}","name":"receipt.pdf","type":"application/pdf","size":{{Pdf.Length}}},{"path":"{{photoPath}}","name":"photo.jpg","type":"image/jpeg","size":{{Photo.Length}}}]""",
            ((JsonNode)s.Record("b1")["attachments"]!).ToJsonString());
        Assert.Null(s.Record("b3")["attachments"]);
        using (var owners = JazminReader.Open(s.Shared, new JazminReadOptions { Key = s.Owner }))
            Assert.Equal(new[] { $"{pdfPath} application/pdf P1", $"{photoPath} image/jpeg P1" }.OrderBy(x => x, StringComparer.Ordinal),
                owners.Files.Select(f => $"{f.Path} {f.Type} {string.Join(",", f.Groups ?? [])}").OrderBy(x => x, StringComparer.Ordinal));
        using (var bobs = JazminReader.Open(s.Shared, new JazminReadOptions { AccessKey = s.Bob }))
        {
            Assert.Equal(Photo, bobs.ReadFile(photoPath));
            Assert.Equal(Pdf, bobs.ReadFile(pdfPath));
        }
        using (var sallys = JazminReader.Open(s.Shared, new JazminReadOptions { AccessKey = s.Sally }))
            Assert.Empty(sallys.Files); // Sally doesn't see P1's rows, so not their files either
    }

    [Fact]
    public void A_file_attached_to_rows_of_two_partitions_is_seen_by_the_keys_of_both()
    {
        var s = Make();
        var photoPath = $"attachments/{s.Team.Id}/{Sha(Photo)}.jpg";
        var first = s.Batch(s.Team, [Row("t1", "P1", null, 1, Paths("p.jpg")), Row("t2", "P2", null, 2, Paths("p.jpg"))], files: [new JazminFileInput("p.jpg", Photo)]);
        Assert.Equal((2L, 0L, 0L, 1, ""), Counts(s.File(s.Team, first)));
        foreach (var key in new[] { s.Bob, s.Sally })
        {
            using var reader = JazminReader.Open(s.Shared, new JazminReadOptions { AccessKey = key });
            Assert.Equal(Photo, reader.ReadFile(photoPath));
        }
        var again = s.Batch(s.Team, [Row("t3", "P1", null, 3, Paths("again.jpg"))], files: [new JazminFileInput("again.jpg", Photo)]);
        Assert.Equal((1L, 0L, 0L, 0, ""), Counts(s.File(s.Team, again))); // already stored for P1
    }

    [Fact]
    public void A_record_sent_again_replaces_the_filed_one_and_the_last_to_arrive_wins()
    {
        var s = Make();
        Assert.Equal((1L, 0L, 0L, 0, ""), Counts(s.File(s.Bob, s.Batch(s.Bob, [Row("b1", "P1", "first", 1)]))));
        var fix = s.Batch(s.Bob, [Row("b1", "P1", "fixed", 1), Row("b2", "P1", "draft", 1), Row("b2", "P1", "final", 1)]);
        Assert.Equal((1L, 1L, 1L, 0, ""), Counts(s.File(s.Bob, fix)));
        Assert.Equal((0L, 0L, 3L, 0, ""), Counts(s.File(s.Bob, fix)));
        Assert.Equal((0L, 2L, 0L, 0, ""), Counts(s.File(s.Team, s.Batch(s.Team, [Row("b1", "P1", "checked", 2), Row("seed", "P1", "seen", 1)]))));
        string Note(string id) => $"{s.Record(id)["note"]}:{s.Record(id)["amount"]}";
        Assert.Equal(["seen:1", "checked:2", "final:1"], new[] { Note("seed"), Note("b1"), Note("b2") });
        var skip = s.File(s.Bob, s.Batch(s.Bob, [Row("b1", "P1", "skipped", 1)]), new JazminFileSubmissionOptions { OnDuplicate = JazminOnDuplicate.Skip });
        Assert.Equal((0L, 0L, 1L, 0, ""), Counts(skip));
        Assert.Equal("checked:2", Note("b1"));
    }

    [Fact]
    public void A_record_outside_the_senders_partitions_is_not_changed_and_no_record_is_moved()
    {
        var s = Make();
        Rejected("^Record 'seed' is in partition 'P1', which key [0-9a-f]{16} isn't granted$", () => s.File(s.Sally, s.Batch(s.Sally, [Row("seed", "P2", "mine now", 0)])));
        Rejected("^Record 'seed' is in partition 'P1': a change can't move it to 'P2'$", () => s.File(s.Team, s.Batch(s.Team, [Row("seed", "P2", "moved", 1)])));
        Assert.Equal("first", s.Record("seed")["note"]);
    }

    [Fact]
    public void A_change_keeps_the_columns_the_sender_cant_see_and_ignores_unknown_ones()
    {
        var s = Make(hideAmount: true);
        var noAmount = BatchColumns.Where(c => c.Name != "amount").ToArray();
        Assert.Equal((0L, 1L, 0L, 0, ""), Counts(s.File(s.Bob, s.Batch(s.Bob, [new() { ["id"] = "seed", ["person"] = "P1", ["note"] = "edited" }], noAmount))));
        Assert.Equal((0L, 1L, 0L, 0, "amount"), Counts(s.File(s.Bob, s.Batch(s.Bob, [Row("seed", "P1", "edited again", 999)]))));
        Assert.Equal(("edited again", 1.0), ((string?)s.Record("seed")["note"], (double?)s.Record("seed")["amount"]));
        Assert.Equal((1L, 0L, 0L, 0, "amount"), Counts(s.File(s.Bob, s.Batch(s.Bob, [Row("b1", "P1", "new", 999)]))));
        Assert.Null(s.Record("b1")["amount"]);
        Assert.Equal((1L, 0L, 0L, 0, "mood"), Counts(s.File(s.Bob, s.Batch(s.Bob, [new() { ["id"] = "b2", ["note"] = "hello", ["mood"] = "good" }],
            [new("id", JazminType.String), new("note", JazminType.String), new("mood", JazminType.String)]))));
        Assert.Equal("P1", s.Record("b2")["person"]);
    }

    [Fact]
    public void A_change_can_send_only_what_changed_and_empty_values_leave_fields_as_they_are()
    {
        var s = Make();
        JazminColumn[] Only(params string[] names) => BatchColumns.Where(c => names.Contains(c.Name)).ToArray();
        (string?, double?) B1() => ((string?)s.Record("b1")["note"], (double?)s.Record("b1")["amount"]);
        s.File(s.Bob, s.Batch(s.Bob, [Row("b1", "P1", "first", 5)]));
        Assert.Equal((0L, 1L, 0L, 0, ""), Counts(s.File(s.Bob, s.Batch(s.Bob, [new() { ["id"] = "b1", ["amount"] = 7.0 }], Only("id", "amount")))));
        Assert.Equal(("first", 7.0), B1());
        Assert.Equal((0L, 0L, 1L, 0, ""), Counts(s.File(s.Bob, s.Batch(s.Bob, [Row("b1", "P1", "", null)]))));
        Assert.Equal(("first", 7.0), B1());
        var three = s.Batch(s.Bob, [new() { ["id"] = "b1", ["note"] = "second" }, new() { ["id"] = "b1", ["amount"] = 9.0 }, new() { ["id"] = "b1", ["note"] = "third" }], Only("id", "note", "amount"));
        Assert.Equal((0L, 1L, 2L, 0, ""), Counts(s.File(s.Bob, three)));
        Assert.Equal(("third", 9.0), B1());
        Assert.Equal((0L, 1L, 0L, 0, ""), Counts(s.File(s.Team, s.Batch(s.Team, [new() { ["id"] = "b1", ["note"] = "team" }], Only("id", "note")))));
        Assert.Equal(("team", 9.0), B1());
        Assert.Equal(["P1:b1", "P1:seed"], s.Rows());
    }

    [Fact]
    public void A_change_keeps_adds_and_removes_a_records_files()
    {
        var s = Make();
        byte[] png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, .. RandomNumberGenerator.GetBytes(1000)];
        var (pdfPath, photoPath, pngPath) = ($"attachments/{s.Bob.Id}/{Sha(Pdf)}.pdf", $"attachments/{s.Bob.Id}/{Sha(Photo)}.jpg", $"attachments/{s.Bob.Id}/{Sha(png)}.png");
        JazminSubmissionResult Send(Dictionary<string, object?>[] rows, params JazminFileInput[] files) => s.File(s.Bob, s.Batch(s.Bob, rows, files: files));
        List<string> Stored()
        {
            using var reader = JazminReader.Open(s.Shared, new JazminReadOptions { Key = s.Owner });
            return reader.Files.Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal).ToList();
        }
        JsonArray Listed(string id) => (JsonArray)s.Record(id)["attachments"]!;
        Assert.Equal((2L, 0L, 0L, 2, ""), Counts(Send([Row("b1", "P1", null, null, Paths("receipt.pdf", "photo.jpg")), Row("b2", "P1", null, null, Paths("photo.jpg"))],
            new JazminFileInput("receipt.pdf", Pdf), new JazminFileInput("photo.jpg", Photo))));
        Assert.Equal((0L, 1L, 0L, 0, ""), Counts(Send([Row("b1", "P1", "only the note")])));
        Assert.Equal(2, Listed("b1").Count);

        var receipt = Listed("b1")[0]!.DeepClone();
        Assert.Equal((0L, 1L, 0L, 1, ""), Counts(Send([Row("b1", "P1", "new photo", null, new JsonArray(receipt, "new.png"))], new JazminFileInput("new.png", png))));
        Assert.Equal([$"{pdfPath} receipt.pdf", $"{pngPath} new.png"], Listed("b1").Select(e => $"{e!["path"]} {e["name"]}"));
        Assert.Equal(new[] { pdfPath, photoPath, pngPath }.OrderBy(p => p, StringComparer.Ordinal), Stored()); // b2 still lists the photo

        Assert.Equal((0L, 1L, 0L, 0, ""), Counts(Send([Row("b2", "P1", null, null, new JsonArray())])));
        Assert.Equal(new[] { pdfPath, pngPath }.OrderBy(p => p, StringComparer.Ordinal), Stored());

        Rejected(@"^Record 'b2' lists 'attachments/[0-9a-f]{16}/[0-9a-f]{64}\.pdf', which isn't one of its files$", () => Send([Row("b2", "P1", null, null, new JsonArray(new JsonObject { ["path"] = pdfPath }))]));
        Rejected("^Record 'b3' lists .*, which isn't one of its files$", () => Send([Row("b3", "P1", null, null, new JsonArray(new JsonObject { ["path"] = pdfPath }))]));
    }

    [Fact]
    public void Batches_with_unlisted_missing_disguised_or_oversized_files_are_rejected_with_the_reason()
    {
        var s = Make();
        void Rejects(JsonNode? attachments, JazminFileInput[] files, string pattern, JazminFileSubmissionOptions? rules = null) =>
            Rejected(pattern, () => s.File(s.Bob, s.Batch(s.Bob, [Row("x", "P1", null, 0, attachments)], files: files), rules));
        Rejects(Paths("a.pdf"), [], "A row lists the file 'a.pdf', which the batch doesn't hold");
        Rejects(Paths("a.pdf"), [new("a.pdf", Pdf), new("extra.pdf", Pdf)], "holds the file 'extra.pdf', which no row lists");
        Rejects(null, [new("a.pdf", Pdf)], "which no row lists");
        Rejects(Paths("page.pdf"), [new("page.pdf", Encoding.UTF8.GetBytes("<script>alert(1)</script>")) { Type = "application/pdf" }], "'page.pdf' is not a PDF, JPEG, PNG or WebP file");
        Rejects(Paths("a.pdf"), [new("a.pdf", Pdf)], "'a.pdf' is not a PNG file", new JazminFileSubmissionOptions { FileTypes = ["image/png"] });
        Rejects(Paths("a.pdf"), [new("a.pdf", Pdf)], @"has \d+ bytes; the limit is 10$", new JazminFileSubmissionOptions { MaxFileBytes = 10 });
        Rejects(Paths("a.pdf", "b.jpg"), [new("a.pdf", Pdf), new("b.jpg", Photo)], @"The batch's files have \d+ bytes; the limit is 100000", new JazminFileSubmissionOptions { MaxBatchFileBytes = 100_000 });
        Rejects(new JsonArray(1), [], "Column 'attachments' must list the paths of the row's files");
        Assert.Equal(["P1:seed"], s.Rows());
    }

    [Fact]
    public void Files_into_a_shared_file_the_JavaScript_library_wrote()
    {
        string? fixtures = null;
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null && fixtures is null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "spec", "fixtures", "keys.json"))) fixtures = Path.Combine(dir.FullName, "spec", "fixtures");
        var keys = JsonNode.Parse(File.ReadAllText(Path.Combine(fixtures!, "keys.json")))!.AsObject();
        var owner = JazminKey.Parse((string)keys["key"]!);
        var bob = JazminAccessKey.Parse((string)keys["bob"]!);
        var shared = Path.Combine(Directory.CreateTempSubdirectory("jazmin-submissions-").FullName, "js-access.jzm");
        File.Copy(Path.Combine(fixtures!, "js-access.jzm"), shared);
        var batch = new MemoryStream();
        using (var writer = new JazminWriter(batch, [new("id", JazminType.Int) { Nullable = false }, new("name", JazminType.String), new("country", JazminType.String)],
            new JazminWriteOptions { Key = owner.SubmissionKey(bob) }, leaveOpen: true))
            writer.WriteRow(new Dictionary<string, object?> { ["id"] = 9001L, ["name"] = "Filed by .NET", ["country"] = "NA" });
        var result = JazminFile.FileSubmission(shared, batch.ToArray(), new JazminFileSubmissionOptions { Key = owner, KeyId = bob.Id });
        Assert.Equal((1L, 0L, 0L, 0, ""), Counts(result));
        using var reader = JazminReader.Open(shared, new JazminReadOptions { Key = owner });
        var row = reader.Find(JazminFilter.Eq("id", 9001L)).Single();
        Assert.Equal(("Filed by .NET", "ZA"), ((string?)row["name"], (string?)row["country"])); // Bob's one partition
    }

    [Fact]
    public void A_shared_file_with_no_files_column_files_new_and_changed_records()
    {
        var owner = JazminKey.Generate();
        var ann = owner.CreateAccessKey();
        var shared = Path.Combine(Directory.CreateTempSubdirectory("jazmin-submissions-").FullName, "field.jzm");
        JazminColumn[] columns = [new("id", JazminType.String) { Nullable = false }, new("inspector", JazminType.String), new("note", JazminType.String)];
        using (var writer = JazminWriter.Create(shared, columns, new JazminWriteOptions
        {
            Key = owner, Access = new JazminAccessOptions { PartitionBy = "inspector", Grants = [new JazminGrant(ann) { Rows = ["ann"] }] },
        }))
        {
            writer.WriteValues("r1", "ann", "roof ok");
        }
        JazminKey submissionKey;
        using (var view = JazminReader.Open(shared, new JazminReadOptions { AccessKey = ann })) submissionKey = view.SubmissionKey!;
        var batch = Path.Combine(Path.GetDirectoryName(shared)!, "batch.jzm");
        using (var writer = JazminWriter.Create(batch, columns, new JazminWriteOptions { Key = submissionKey }))
        {
            writer.WriteValues("r1", null, "roof leaks");
            writer.WriteValues("r2", null, "gate broken");
        }
        var result = JazminFile.FileSubmission(shared, File.ReadAllBytes(batch), new JazminFileSubmissionOptions { Key = owner, KeyId = ann.Id });
        Assert.Equal((1L, 1L), (result.Filed, result.Updated));
        using var reader = JazminReader.Open(shared, new JazminReadOptions { Key = owner });
        Assert.Equal(["r1: roof leaks", "r2: gate broken"], reader.Rows().Select(r => $"{r["id"]}: {r["note"]}").Order());
    }
}
