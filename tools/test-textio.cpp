// Unit tests for the save path: message parsing, UTF-8 conversion, and the
// file writer. These exercise the same header the app compiles in, so a pass
// here is a statement about the shipping code, not a copy of it.
//
//   cl /nologo /std:c++17 /EHsc /utf-8 /I..\src test-textio.cpp && test-textio.exe

#include "textio.h"
#include <string>
#include <vector>
#include <cstdio>
#include <filesystem>
#include <fstream>

static int g_fail = 0;

static void Check(bool ok, const char* what) {
    if (!ok) { printf("FAIL  %s\n", what); g_fail++; }
}

static std::string ReadAll(const std::wstring& path) {
    std::ifstream f(path, std::ios::binary);
    return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

int main() {
    // ---- JsonGetString: the exact shape the page posts --------------------
    {
        std::wstring out;
        Check(mdv::JsonGetString(LR"({"type":"saveDoc","text":"# Title\n\nBody"})", L"text", out) &&
              out == L"# Title\n\nBody", "JsonGetString: newlines unescaped");

        Check(mdv::JsonGetString(LR"({"text":"quote \" and backslash \\ done"})", L"text", out) &&
              out == L"quote \" and backslash \\ done", "JsonGetString: quotes and backslashes");

        Check(mdv::JsonGetString(LR"({"text":"tab\there\r\ncrlf"})", L"text", out) &&
              out == L"tab\there\r\ncrlf", "JsonGetString: tab and CRLF escapes");

        Check(mdv::JsonGetString(LR"({"text":"unicode é 中 done"})", L"text", out) &&
              out == L"unicode é 中 done", "JsonGetString: \\u escapes");

        // A key appearing inside another value must not confuse the reader.
        Check(mdv::JsonGetString(LR"({"text":"the word type: here","type":"saveDoc"})", L"type", out) &&
              out == L"saveDoc", "JsonGetString: key not matched inside a value");

        Check(!mdv::JsonGetString(LR"({"type":"x"})", L"text", out), "JsonGetString: missing key returns false");

        // A large payload with escapes on every line (a realistic document).
        std::wstring big = L"{\"text\":\"";
        std::wstring expect;
        for (int i = 0; i < 5000; i++) { big += L"line \\\"q\\\" \\n"; expect += L"line \"q\" \n"; }
        big += L"\"}";
        Check(mdv::JsonGetString(big, L"text", out) && out == expect, "JsonGetString: large escaped payload");
    }

    // ---- Narrow: wide -> UTF-8 -------------------------------------------
    {
        std::string s = mdv::Narrow(L"café 中文 \U0001F680");
        Check(s == "caf\xC3\xA9 \xE4\xB8\xAD\xE6\x96\x87 \xF0\x9F\x9A\x80",
              "Narrow: accents, CJK and astral plane round-trip to UTF-8");
        Check(mdv::Widen(s.data(), (int)s.size()) == L"café 中文 \U0001F680",
              "Widen: UTF-8 back to wide");
    }

    // ---- ApplyTextConventions -------------------------------------------
    {
        Check(mdv::ApplyTextConventions("a\nb\n", false, false) == "a\nb\n", "conventions: LF stays LF");
        Check(mdv::ApplyTextConventions("a\nb\n", true, false) == "a\r\nb\r\n", "conventions: LF -> CRLF");
        Check(mdv::ApplyTextConventions("a\n", false, true) == "\xEF\xBB\xBF" "a\n", "conventions: BOM preserved");
        Check(mdv::ApplyTextConventions("a\nb", true, true) == "\xEF\xBB\xBF" "a\r\nb",
              "conventions: BOM and CRLF together");
        Check(mdv::ApplyTextConventions("", false, false).empty(), "conventions: empty document stays empty");
        Check(mdv::ApplyTextConventions("a\r\nb", true, false) == "a\r\r\nb",
              "conventions: existing CR is left alone (page always sends LF)");
    }

    // ---- NormalizeToUtf8 ---------------------------------------------------
    // The ANSI-fallback path's exact decoded text depends on the system's
    // active code page, which this test can't assume -- so invalid inputs
    // are checked via "the function transcoded it" (result != raw), not a
    // specific expected string. Valid inputs are checked via "the function
    // passed it through unchanged" (result == raw), which IS
    // codepage-independent and is the real thing under test: does validation
    // correctly distinguish these two cases?
    {
        auto isValidUtf8 = [](const std::string& s) { return mdv::NormalizeToUtf8(s) == s; };

        // Positive controls: real, valid multi-byte UTF-8 stays byte-identical.
        Check(isValidUtf8(mdv::Narrow(L"plain ascii")), "NormalizeToUtf8: plain ASCII validates");
        Check(isValidUtf8(mdv::Narrow(L"café 中文 \U0001F680")),
              "NormalizeToUtf8: real accented/CJK/astral UTF-8 validates unchanged");
        Check(isValidUtf8(""), "NormalizeToUtf8: empty string validates");
        // U+10FFFF itself (the maximum valid code point) and U+E000 (just
        // above the surrogate range) and U+D7FF (just below it) -- the exact
        // boundaries a fix that's too strict would incorrectly reject.
        Check(isValidUtf8(mdv::Narrow(L"\U0010FFFF")), "NormalizeToUtf8: U+10FFFF (max valid code point) validates");
        Check(isValidUtf8(mdv::Narrow(L"")), "NormalizeToUtf8: U+E000 (just above the surrogate range) validates");
        Check(isValidUtf8(mdv::Narrow(L"퟿")), "NormalizeToUtf8: U+D7FF (just below the surrogate range) validates");

        // Overlong encodings: structurally shaped (right length, right
        // continuation-byte bits) but encoding a code point that a SHORTER
        // sequence should have used -- must be rejected, not just accepted
        // because the byte shape looks right.
        Check(!isValidUtf8(std::string("\xC0\x80", 2)), "NormalizeToUtf8: overlong 2-byte (C0 80, NUL) is rejected");
        Check(!isValidUtf8(std::string("\xC1\xBF", 2)), "NormalizeToUtf8: overlong 2-byte (C1 BF, U+007F) is rejected");
        Check(!isValidUtf8(std::string("\xE0\x80\x80", 3)), "NormalizeToUtf8: overlong 3-byte (E0 80 80, NUL) is rejected");
        Check(!isValidUtf8(std::string("\xF0\x80\x80\x80", 4)), "NormalizeToUtf8: overlong 4-byte (F0 80 80 80, NUL) is rejected");

        // Surrogate halves (D800-DFFF): valid only as a UTF-16 encoding
        // artifact, forbidden in UTF-8 by the format itself.
        Check(!isValidUtf8(std::string("\xED\xA0\x80", 3)), "NormalizeToUtf8: encoded surrogate U+D800 is rejected");
        Check(!isValidUtf8(std::string("\xED\xBF\xBF", 3)), "NormalizeToUtf8: encoded surrogate U+DFFF is rejected");

        // Beyond the Unicode maximum (U+10FFFF).
        Check(!isValidUtf8(std::string("\xF4\x90\x80\x80", 4)), "NormalizeToUtf8: U+110000 (one past max) is rejected");
        Check(!isValidUtf8(std::string("\xF5\x80\x80\x80", 4)), "NormalizeToUtf8: F5 leading byte (always > max) is rejected");

        // A truncated trailing sequence (a 2-byte leader with nothing after
        // it) -- pre-existing behavior, confirmed still correct after the
        // validation loop was rewritten to compute real code points.
        Check(!isValidUtf8(std::string("\xC3", 1)), "NormalizeToUtf8: truncated multi-byte sequence at EOF is rejected");

        // BOM/UTF-16 handling is untouched by this fix -- confirm it still works.
        Check(mdv::NormalizeToUtf8("\xEF\xBB\xBF" "hi") == "hi", "NormalizeToUtf8: UTF-8 BOM is stripped");
        {
            std::string utf16le("\xFF\xFE" "h\0i\0", 6);
            Check(mdv::NormalizeToUtf8(utf16le) == "hi", "NormalizeToUtf8: UTF-16LE BOM decodes correctly");
            std::string utf16be("\xFE\xFF\0h\0i", 6);
            Check(mdv::NormalizeToUtf8(utf16be) == "hi", "NormalizeToUtf8: UTF-16BE BOM decodes correctly");
        }

        // The optional encodingOut param (docs/BACKLOG.md's document-info
        // feature) -- one call per branch, confirming it reports exactly
        // which path NormalizeToUtf8 itself took, not a guess re-derived
        // from the output. Defaulted to nullptr above so every prior
        // assertion in this block already covers the zero-arg call site.
        {
            mdv::TextEncoding enc;
            mdv::NormalizeToUtf8(mdv::Narrow(L"plain ascii"), &enc);
            Check(enc == mdv::TextEncoding::Utf8, "NormalizeToUtf8: reports Utf8 for valid UTF-8 with no BOM");
            mdv::NormalizeToUtf8("\xEF\xBB\xBF" "hi", &enc);
            Check(enc == mdv::TextEncoding::Utf8Bom, "NormalizeToUtf8: reports Utf8Bom for a UTF-8 BOM");
            std::string utf16le("\xFF\xFE" "h\0i\0", 6);
            mdv::NormalizeToUtf8(utf16le, &enc);
            Check(enc == mdv::TextEncoding::Utf16LE, "NormalizeToUtf8: reports Utf16LE for a UTF-16LE BOM");
            std::string utf16be("\xFE\xFF\0h\0i", 6);
            mdv::NormalizeToUtf8(utf16be, &enc);
            Check(enc == mdv::TextEncoding::Utf16BE, "NormalizeToUtf8: reports Utf16BE for a UTF-16BE BOM");
            mdv::NormalizeToUtf8(std::string("\xC0\x80", 2), &enc);   // an invalid sequence, forces the ANSI fallback
            Check(enc == mdv::TextEncoding::Ansi, "NormalizeToUtf8: reports Ansi when validation fails and it falls back");
            Check(std::wstring(mdv::TextEncodingLabel(mdv::TextEncoding::Utf16LE)) == L"UTF-16 LE",
                  "TextEncodingLabel: UTF-16 LE has its expected display label");
        }
    }

    // ---- WriteTextFile ---------------------------------------------------
    {
        std::filesystem::path dir = std::filesystem::temp_directory_path() / "mdv-textio-test";
        std::filesystem::remove_all(dir);
        std::filesystem::create_directories(dir);
        std::wstring target = (dir / L"doc.md").wstring();
        std::wstring err;

        // New file (no existing target -> MoveFileEx fallback path).
        Check(mdv::WriteTextFile(target, "# New\n", false, false, err), "write: creates a new file");
        Check(ReadAll(target) == "# New\n", "write: new file contents exact");

        // Overwrite preserving CRLF + BOM.
        Check(mdv::WriteTextFile(target, "line1\nline2\n", true, true, err), "write: overwrite existing");
        Check(ReadAll(target) == "\xEF\xBB\xBF" "line1\r\nline2\r\n", "write: CRLF and BOM applied");

        // No stray temp files left behind.
        int leftovers = 0;
        for (auto& e : std::filesystem::directory_iterator(dir))
            if (e.path().filename() != L"doc.md") leftovers++;
        Check(leftovers == 0, "write: no temporary files left behind");

        // A big document round-trips byte for byte.
        std::string big;
        for (int i = 0; i < 60000; i++) big += "some markdown line with UTF-8 \xC3\xA9\n";
        Check(mdv::WriteTextFile(target, big, false, false, err), "write: large document");
        Check(ReadAll(target) == big, "write: large document byte-exact");

        // Failure must leave the previous contents intact.
        Check(mdv::WriteTextFile(target, "keep me\n", false, false, err), "write: reset for failure test");
        std::wstring badPath = (dir / L"missing-subdir" / L"x.md").wstring();
        Check(!mdv::WriteTextFile(badPath, "nope", false, false, err), "write: fails on a missing directory");
        Check(ReadAll(target) == "keep me\n", "write: failed save left the original file untouched");

        // Read-only target reports a clear error rather than silently failing.
        SetFileAttributesW(target.c_str(), FILE_ATTRIBUTE_READONLY);
        bool roOk = mdv::WriteTextFile(target, "changed\n", false, false, err);
        SetFileAttributesW(target.c_str(), FILE_ATTRIBUTE_NORMAL);
        if (!roOk) Check(!err.empty(), "write: read-only failure carries a message");
        Check(!roOk || ReadAll(target) == "changed\n", "write: read-only either fails cleanly or writes fully");

        std::filesystem::remove_all(dir);
    }

    // ---- WriteTextFile: a directory deep enough that GetTempFileNameW ----
    // ---- (the old implementation) would have failed ----------------------
    // GetTempFileNameW fails outright once the directory prefix + its own
    // generated 8.3-shaped filename would exceed MAX_PATH (260 chars) -- a
    // hard limitation of that specific API, unaffected by this app's own
    // longPathAware manifest setting. This test-textio.exe binary has no
    // manifest of its own (it's a standalone tool, not the app), so it
    // relies on the \\?\ prefix -- the mechanism that has ALWAYS bypassed
    // MAX_PATH in Win32, independent of any manifest opt-in -- to build and
    // address a genuinely long path deterministically, rather than assuming
    // a manifest-driven opt-in this binary doesn't have.
    {
        std::filesystem::path base = std::filesystem::temp_directory_path() / "mdv-longpath-test";
        std::wstring longDirPrefixed = L"\\\\?\\" + base.wstring();
        // CreateDirectoryW only ever creates ONE new level at a time (unlike
        // std::filesystem::create_directories), so the base itself needs to
        // exist before appending long segments onto it.
        CreateDirectoryW(longDirPrefixed.c_str(), nullptr);

        // Build ~40-char segments until the total comfortably exceeds
        // MAX_PATH. A prior run's deep tree, if any, is cleaned up the same
        // way it was built -- walked from the deepest segment back up --
        // at the end of this block, since RemoveDirectoryW (like
        // CreateDirectoryW) only ever touches one empty leaf at a time.
        std::wstring longDir = longDirPrefixed;
        bool createOk = true;
        for (int seg = 0; seg < 8 && createOk; seg++) {
            longDir += L"\\segment_of_this_path_" + std::to_wstring(seg) + L"_padded_out";
            if (!CreateDirectoryW(longDir.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS)
                createOk = false;
        }
        // longDir (without the \\?\ prefix) should now comfortably exceed
        // MAX_PATH; confirm the premise before trusting the test result.
        size_t bareLen = longDir.size() - 4; // minus "\\?\"
        Check(createOk, "write (long path): could build the deep test directory");
        Check(bareLen > MAX_PATH, "write (long path): the test directory genuinely exceeds MAX_PATH");

        std::wstring longTarget = longDir + L"\\doc.md";
        std::wstring longErr;
        bool longWriteOk = mdv::WriteTextFile(longTarget, "# Long path\n", false, false, longErr);
        Check(longWriteOk, "write (long path): succeeds past MAX_PATH (was: GetTempFileNameW failure)");
        Check(!longWriteOk || ReadAll(longTarget) == "# Long path\n", "write (long path): content is correct");

        // No stray temp files left in the long-path directory either.
        if (longWriteOk) {
            int longLeftovers = 0;
            for (auto& e : std::filesystem::directory_iterator(longDir))
                if (e.path().filename() != L"doc.md") longLeftovers++;
            Check(longLeftovers == 0, "write (long path): no temporary files left behind");
        }

        // Best-effort cleanup, walking back down from the deepest segment,
        // one extra iteration to also remove the base directory itself.
        DeleteFileW(longTarget.c_str());
        std::wstring rm = longDir;
        for (int seg = 0; seg <= 8; seg++) {
            RemoveDirectoryW(rm.c_str());
            size_t cut = rm.find_last_of(L'\\');
            if (cut == std::wstring::npos) break;
            rm = rm.substr(0, cut);
        }
    }

    printf(g_fail == 0 ? "ALL TEXTIO TESTS PASSED\n" : "%d TEXTIO TESTS FAILED\n", g_fail);
    return g_fail == 0 ? 0 : 1;
}
