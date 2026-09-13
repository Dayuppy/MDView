// Text plumbing shared by the app and its unit tests: UTF-8 conversion, the
// minimal JSON string reader used for messages from the page, and the file
// writer that saves documents. Kept header-only and free of app state so
// tools/test-textio.cpp can exercise the exact code the app runs.
#pragma once

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <string>
#include <algorithm>

namespace mdv {

inline std::string Narrow(const std::wstring& w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, 0);
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), n, nullptr, nullptr);
    return s;
}

inline std::wstring Widen(const char* p, int len) {
    if (len <= 0) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, p, len, nullptr, 0);
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, p, len, w.data(), n);
    return w;
}

// What NormalizeToUtf8 actually found the raw bytes to be -- purely
// informational (shown to the reader as document info), never a behavior
// switch elsewhere, so getting this wrong has no security or correctness
// angle the way the conversion itself does.
enum class TextEncoding { Utf8, Utf8Bom, Utf16LE, Utf16BE, Ansi };

// Normalize any text file to UTF-8 (BOM detection, UTF-16 both endians, ANSI
// fallback). The UTF-8 validation is strict, not merely structural: the
// length-prefix/continuation-byte shape a naive check settles for still lets
// three real bug classes through as "valid" -- an overlong encoding (e.g. the
// two-byte sequence C0 80 for NUL, which must be one byte), a UTF-16
// surrogate half (D800-DFFF) encoded directly in UTF-8, which the format
// forbids, and a code point beyond the Unicode maximum U+10FFFF. None of
// these have a security angle here (nothing downstream makes a decision on
// the raw bytes; a browser's own decoder substitutes U+FFFD, and DOMPurify
// sanitizes after that) but a real, reachable case exists: a CP1252-encoded
// byte in the 0xC0-0xFF range immediately followed by one or two bytes in
// 0x80-0xBF (e.g. an accented capital letter followed by a Windows "smart
// quote") can validate as a structurally-shaped-but-overlong or otherwise
// invalid UTF-8 sequence and render as mojibake instead of correctly taking
// the ANSI fallback below.
inline std::string NormalizeToUtf8(std::string raw, TextEncoding* encodingOut = nullptr) {
    auto setEnc = [&](TextEncoding e) { if (encodingOut) *encodingOut = e; };
    const unsigned char* b = (const unsigned char*)raw.data();
    size_t n = raw.size();
    if (n >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) {
        // erase(0,3) shifts the buffer in place (no second allocation+copy of
        // the whole document the way substr(3) would) -- raw is already an
        // owned by-value copy with nothing else referencing it.
        raw.erase(0, 3);
        setEnc(TextEncoding::Utf8Bom);
        return raw;
    }
    if (n >= 2 && b[0] == 0xFF && b[1] == 0xFE) {
        std::wstring w((const wchar_t*)(raw.data() + 2), (n - 2) / 2);
        setEnc(TextEncoding::Utf16LE);
        return Narrow(w);
    }
    if (n >= 2 && b[0] == 0xFE && b[1] == 0xFF) {
        std::wstring w;
        w.reserve((n - 2) / 2);
        for (size_t i = 2; i + 1 < n; i += 2)
            w += (wchar_t)((b[i] << 8) | b[i + 1]);
        setEnc(TextEncoding::Utf16BE);
        return Narrow(w);
    }
    // Strict UTF-8 validation: decode each sequence's actual code point (not
    // just its byte-length shape) and reject overlong encodings, surrogate
    // halves, and anything past U+10FFFF -- see the function comment above.
    static const unsigned int kMinForLen[5] = { 0, 0, 0x80, 0x800, 0x10000 };
    bool valid = true;
    for (size_t i = 0; i < n && valid;) {
        unsigned char c = b[i];
        int len = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 0;
        if (!len || i + len > n) { valid = false; break; }
        unsigned int cp = (len == 1) ? c : (c & (0xFFu >> (len + 1)));
        for (int k = 1; k < len; k++) {
            unsigned char cc = b[i + k];
            if ((cc & 0xC0) != 0x80) { valid = false; break; }
            cp = (cp << 6) | (cc & 0x3Fu);
        }
        if (!valid) break;
        if (cp < kMinForLen[len] || cp > 0x10FFFFu || (cp >= 0xD800u && cp <= 0xDFFFu)) { valid = false; break; }
        i += len;
    }
    if (valid) { setEnc(TextEncoding::Utf8); return raw; }
    // ANSI fallback
    int wn = MultiByteToWideChar(CP_ACP, 0, raw.data(), (int)raw.size(), nullptr, 0);
    std::wstring w(wn, 0);
    MultiByteToWideChar(CP_ACP, 0, raw.data(), (int)raw.size(), w.data(), wn);
    setEnc(TextEncoding::Ansi);
    return Narrow(w);
}

inline const wchar_t* TextEncodingLabel(TextEncoding e) {
    switch (e) {
    case TextEncoding::Utf8Bom: return L"UTF-8 (BOM)";
    case TextEncoding::Utf16LE: return L"UTF-16 LE";
    case TextEncoding::Utf16BE: return L"UTF-16 BE";
    case TextEncoding::Ansi:    return L"ANSI";
    default:                    return L"UTF-8";
    }
}

// Extract a top-level string value ("key":"value") from the flat JSON our own
// page produces. A real quote cannot occur unescaped inside a JSON string, so
// searching for the quoted key never matches inside another value.
inline bool JsonGetString(const std::wstring& json, const wchar_t* key, std::wstring& out) {
    std::wstring pat = L"\"";
    pat += key;
    pat += L"\"";
    size_t pos = json.find(pat);
    if (pos == std::wstring::npos) return false;
    pos += pat.size();
    while (pos < json.size() && iswspace(json[pos])) pos++;
    if (pos >= json.size() || json[pos] != L':') return false;
    pos++;
    while (pos < json.size() && iswspace(json[pos])) pos++;
    if (pos >= json.size() || json[pos] != L'"') return false;
    pos++;
    std::wstring val;
    while (pos < json.size()) {
        wchar_t c = json[pos];
        if (c == L'"') { out = val; return true; }
        if (c == L'\\' && pos + 1 < json.size()) {
            wchar_t e = json[++pos];
            switch (e) {
            case L'"': val += L'"'; break;
            case L'\\': val += L'\\'; break;
            case L'/': val += L'/'; break;
            case L'b': val += L'\b'; break;
            case L'f': val += L'\f'; break;
            case L'n': val += L'\n'; break;
            case L'r': val += L'\r'; break;
            case L't': val += L'\t'; break;
            case L'u':
                if (pos + 4 < json.size()) {
                    wchar_t hex[5] = { json[pos + 1], json[pos + 2], json[pos + 3], json[pos + 4], 0 };
                    val += (wchar_t)wcstoul(hex, nullptr, 16);
                    pos += 4;
                }
                break;
            default: val += e; break;
            }
        } else {
            val += c;
        }
        pos++;
    }
    return false;
}

// Apply the document's original line-ending and BOM conventions to LF text.
inline std::string ApplyTextConventions(const std::string& utf8Lf, bool crlf, bool bom) {
    std::string out;
    out.reserve(utf8Lf.size() + (crlf ? utf8Lf.size() / 20 : 0) + 3);
    if (bom) out += "\xEF\xBB\xBF";
    if (crlf) {
        for (size_t i = 0; i < utf8Lf.size(); i++) {
            if (utf8Lf[i] == '\n') out += "\r\n";
            else out += utf8Lf[i];
        }
    } else {
        out += utf8Lf;
    }
    return out;
}

// Write text to `path`, preserving the file's conventions. The temp-file-then-
// replace dance means a failure part way through leaves the original intact
// rather than truncated.
inline bool WriteTextFile(const std::wstring& path, const std::string& utf8Lf,
                          bool crlf, bool bom, std::wstring& error) {
    const std::string out = ApplyTextConventions(utf8Lf, crlf, bom);

    size_t slash = path.find_last_of(L"\\/");
    std::wstring dir = slash == std::wstring::npos ? L"." : path.substr(0, slash);

    // GetTempFileNameW's own documentation states it fails whenever the
    // directory prefix plus the generated 8.3-shaped filename would exceed
    // MAX_PATH (260 chars) -- a hard limitation of that specific API, NOT
    // affected by this app's own longPathAware manifest setting (which only
    // extends CreateFileW and friends, the API this function otherwise uses
    // throughout). So a document that opens fine (main.cpp's OpenDocument
    // uses 4096-char buffers throughout) could not be SAVED once its
    // directory was deep enough, reporting a misleading "temporary file"
    // error that was really a path-length problem. Generate the sibling
    // name directly instead: CREATE_NEW gives the same atomic
    // "this name didn't already exist" guarantee GetTempFileNameW provided,
    // through the same long-path-aware API this function already relies on
    // for everything else, with no length ceiling of its own.
    std::wstring tmp;
    HANDLE h = INVALID_HANDLE_VALUE;
    for (int attempt = 0; attempt < 16; attempt++) {
        wchar_t name[64];
        swprintf(name, 64, L"\\mdv%08lx%04x.tmp", GetCurrentProcessId(),
            (unsigned)(GetTickCount64() + attempt) & 0xFFFFu);
        tmp = dir + name;
        h = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                        FILE_ATTRIBUTE_TEMPORARY, nullptr);
        if (h != INVALID_HANDLE_VALUE) break;
        if (GetLastError() != ERROR_FILE_EXISTS) break;
    }
    if (h == INVALID_HANDLE_VALUE) {
        error = L"Could not create a temporary file next to the document.";
        return false;
    }

    bool ok = true;
    size_t off = 0;
    while (off < out.size()) {
        DWORD chunk = (DWORD)(std::min)(out.size() - off, (size_t)(1 << 20));
        DWORD written = 0;
        if (!WriteFile(h, out.data() + off, chunk, &written, nullptr) || written == 0) { ok = false; break; }
        off += written;
    }
    if (ok) ok = FlushFileBuffers(h) != 0;
    CloseHandle(h);
    if (!ok) {
        DeleteFileW(tmp.c_str());
        error = L"Could not write the file. It may be full or read-only.";
        return false;
    }

    // ReplaceFileW keeps the original's attributes and ACLs; it needs the
    // target to exist, so fall back to a move for brand-new files.
    if (!ReplaceFileW(path.c_str(), tmp.c_str(), nullptr, REPLACEFILE_IGNORE_MERGE_ERRORS, nullptr, nullptr)) {
        DWORD err = GetLastError();
        if (err == ERROR_FILE_NOT_FOUND) {
            if (MoveFileExW(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                return true;
            err = GetLastError();
        }
        DeleteFileW(tmp.c_str());
        error = err == ERROR_ACCESS_DENIED
            ? L"Access denied. The file may be read-only or open in another program."
            : L"Could not replace the file on disk.";
        return false;
    }
    return true;
}

} // namespace mdv
