// MD Viewer — a fast, tiny, accessible Markdown document viewer for Windows.
//
// Architecture: a single small Win32 executable hosting the OS-provided WebView2
// (Chromium) engine. All UI assets (HTML/CSS/JS, markdown renderer, math fonts)
// are embedded as resources and served from memory via WebResourceRequested —
// nothing is unpacked to disk. User preferences persist inside an NTFS alternate
// data stream attached to this .exe itself, so the program leaves no registry
// keys, no AppData folders, and no files beside it. The WebView2 engine's
// mandatory browser profile is pointed at %TEMP% (in-private) and swept away.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <windowsx.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <dwmapi.h>
#include <objbase.h>
#include <psapi.h>
#include <string>
#include <vector>
#include <functional>
#include <algorithm>
#include <filesystem>
#include <memory>
#include <cstdio>
#include <cwctype>
#include <climits>
#include <exception>

#include <wrl.h>

#include "WebView2.h"
#include "WebView2EnvironmentOptions.h"
#include "resource.h"
#include "textio.h"

using mdv::Narrow;
using mdv::Widen;
using mdv::JsonGetString;
using mdv::WriteTextFile;
using mdv::ApplyTextConventions;
using mdv::NormalizeToUtf8;

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "version.lib")
#pragma comment(lib, "psapi.lib")

// ---------------------------------------------------------------- constants

static const wchar_t* kWndClass   = L"SimpleMDViewerWindow";
static const wchar_t* kAppTitle   = L"MD Viewer";
static const wchar_t* kVersion    = L"1.0.0";
static const wchar_t* kAppOrigin  = L"https://app.local/";
static const wchar_t* kDocOrigin  = L"https://doc.local/";
static const wchar_t* kAdsSettings = L":mdv.settings";   // JS-owned settings JSON
static const wchar_t* kAdsWindow   = L":mdv.window";     // native window placement
static const UINT WM_APP_WATCH = WM_APP + 1;
static const UINT_PTR TIMER_RELOAD = 1;
static const UINT_PTR TIMER_DEBUG_EXIT = 2;
static const UINT_PTR TIMER_DEBUG_WATCHDOG = 3;
static const UINT_PTR TIMER_DEBUG_REOPEN = 4;
static const UINT_PTR TIMER_DEBUG_RESTORE = 5;
static const UINT_PTR TIMER_DEBUG_MODAL_CLOSE = 6;

// Diagnostic logging: always compiled in, everywhere, at negligible cost —
// see AppendLog()/CrashHandler() near wWinMain. This machine has Windows
// Error Reporting disabled, so without an explicit log an unhandled
// exception leaves no trace at all; the process just silently vanishes.
static std::wstring g_logPath;   // overridden by --mdv-log in a debug build
static void AppendLog(const std::wstring& line);   // defined near wWinMain; used earlier too
static void ShowFatalError(const wchar_t* msg);     // ditto
#ifdef MDV_DEBUG
static void CaptureDebugScreenshot();   // defined near wWinMain; used earlier too
static void WriteDebugProfile();        // ditto
static void ArmDebugWatchdog();         // ditto
#endif

// Monotonic milliseconds since process start, for log timestamps. Wall-clock
// time answers "when", but every question worth asking of these logs is
// "how long between these two lines" — so carry the elapsed figure directly
// rather than making the reader subtract clock times by hand.
static LARGE_INTEGER g_qpcFreq{}, g_qpcStart{};
static double ElapsedMs() {
    if (!g_qpcFreq.QuadPart) return 0.0;
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    return (double)(now.QuadPart - g_qpcStart.QuadPart) * 1000.0 / (double)g_qpcFreq.QuadPart;
}

#ifdef MDV_DEBUG
// Scripted/headless testing support — compiled only into the separate
// MDView.debug.exe (see build.ps1 -Debug), never into the shipping exe.
static bool g_debugHeadless = false;
static std::wstring g_debugScreenshotPath;
static int g_debugExitAfterMs = -1;
static std::wstring g_debugProfilePath;   // --mdv-profile: machine-readable run summary
static int g_debugTimeoutMs = 30000;      // --mdv-timeout: hard watchdog, see ArmDebugWatchdog
static int g_debugRepeat = 1;             // --mdv-repeat: re-render N times and report stats
static int g_debugReopenAfterMs = -1;     // --mdv-reopen-after: re-issue OpenDocument on the
                                           // same file this many ms after launch, to exercise
                                           // the supersede-a-still-rendering-document path
                                           // through the real pipeline rather than a mock.
static bool g_debugEditorTest = false;    // --mdv-editor-test: run the write-mode toolbar's
                                           // self-test after the first render and report pass/fail
// --mdv-trav-dir=NAME: the __abs__/ path-traversal probe's target directory
// name, forwarded to the page as BOOT.travDir (see debugRunEditorTest's own
// comment in app.js) so tools/regression.ps1's own $travTargetDir variable
// is the single place that name is ever spelled out -- previously a second,
// independently hardcoded literal in app.js, which a rename in one place
// without the other would have left silently passing the traversal check
// for the wrong reason (404 because the file doesn't exist at the mismatched
// path, not because IsSafeLocalPath() actually rejected it). Defaults to
// today's literal so a bare --mdv-editor-test run (no regression.ps1)
// behaves identically.
static std::wstring g_debugTravDir = L"mdview-regression-outside";
static std::wstring g_debugRenderStats;   // last renderComplete/benchComplete payload from the page
static const wchar_t* g_debugOutcome = L"ok";
// Experiment switches: let a hypothesis be A/B tested across runs without a
// rebuild between each one, so the two numbers being compared come from the
// same binary and differ only in the thing under test.
static bool g_debugPersistProfile = false;   // --mdv-persist-profile
static int g_debugFrameBudget = 0;           // --mdv-frame-budget (0 = leave app.js default)
static std::wstring g_debugCrashTest;        // --mdv-crash-test=seh|terminate: deliberately
                                              // trigger CrashHandler()/TerminateHandler() once
                                              // the page is ready, to verify this forensic
                                              // logging infrastructure actually works -- neither
                                              // handler is exercised by any other debug flag.
static bool g_debugFatalErrorTest = false;   // --mdv-fatal-error-test: deliberately call
                                              // ShowFatalError() once the page is ready. The
                                              // three real call sites (WebView2 environment/
                                              // controller creation failing) can't be forced
                                              // without actually breaking the WebView2 runtime
                                              // on the machine running this suite, but
                                              // ShowFatalError()'s own risk -- a MessageBoxW
                                              // that would block forever in a headless run --
                                              // is independent of which caller reached it, so
                                              // testing it directly gives real coverage of the
                                              // actual hang risk.
static bool g_debugDpiTest = false;          // --mdv-dpi-test: synthesize a real WM_DPICHANGED
                                              // once the page is ready, with a distinctive
                                              // suggested rect, then log the window's actual
                                              // post-message rect. A genuine monitor/DPI change
                                              // can't be produced in this single-monitor
                                              // headless environment, but WM_DPICHANGED's own
                                              // handler is a plain SetWindowPos call driven
                                              // entirely by the RECT* in lParam -- sending the
                                              // real message with a controlled RECT exercises
                                              // that handler for real, not simulated.
static bool g_debugMinimizeTest = false;     // --mdv-minimize-test: minimize the window then
                                              // restore it shortly after, once the page is
                                              // ready. WM_SIZE's SIZE_MINIMIZED branch (hides
                                              // the WebView2 controller via put_IsVisible(FALSE),
                                              // then restores visibility+bounds on un-minimize)
                                              // is deliberately never reached by any other
                                              // headless scenario -- this whole harness keeps
                                              // its window off-screen rather than minimized
                                              // specifically because a minimized/hidden window's
                                              // Page Visibility API throttles the timers the
                                              // progressive renderer's pacing depends on (see
                                              // SLICE_BUDGET_MS's own comment in app.js) -- so
                                              // this path had never been exercised at all.
static std::wstring g_debugProfileDirOverride;  // --mdv-profile-dir=PATH: use this WebView2
                                                 // user-data folder instead of the shared
                                                 // %TEMP%\MDView(.debug).wv2 default. Each
                                                 // regression scenario currently wipes that one
                                                 // shared directory before every launch
                                                 // (Run()/profile-run.ps1 both do this), which is
                                                 // what makes running scenarios in parallel unsafe
                                                 // -- two concurrent instances would delete and
                                                 // recreate the SAME profile out from under each
                                                 // other. Giving each scenario its own directory
                                                 // removes that shared-mutable-state hazard
                                                 // entirely, independent of g_solo (which guards a
                                                 // different thing: a second REAL instance never
                                                 // sweeping the first's live profile).
static bool g_debugMinMaxTest = false;       // --mdv-minmax-test: send a real WM_GETMINMAXINFO
                                              // to the window once ready and log the resulting
                                              // ptMinTrackSize. This handler enforces the app's
                                              // real, DPI-scaled minimum window size (420x320
                                              // DIPs) -- a genuine UX constraint that had never
                                              // been exercised by anything in this harness. No
                                              // on-screen disruption: sending the message
                                              // directly and reading the struct it fills in
                                              // exercises the handler without an actual resize.
static bool g_debugRejectionTest = false;    // --mdv-rejection-test: deliberately create an
                                              // unhandled Promise rejection on the page. Every
                                              // "no uncaught JS errors" check across this whole
                                              // suite relies on window.addEventListener(
                                              // 'unhandledrejection', ...) forwarding into the
                                              // same [js:error] log line the synchronous
                                              // 'error' listener uses -- but nothing had ever
                                              // deliberately triggered THIS listener specifically
                                              // to confirm it actually does. If it were ever
                                              // broken, an entire class of real bugs (any async/
                                              // Promise-based failure) would silently pass every
                                              // "no JS errors" check in this suite without any
                                              // of them noticing.
static bool g_debugSelfTokenTest = false;    // --mdv-self-token-test: right after the first real
                                              // file open, issue two REAL fetches through the real
                                              // https://doc.local/__self__ handler -- one with a
                                              // deliberately stale ?tok= (must 409), one with the
                                              // current one (must 200 with the exact current text)
                                              // -- proving the g_docToken guard the actual C++ code
                                              // enforces, not a reimplementation of it. See
                                              // g_docToken's own comment for the race this closes:
                                              // an in-flight __self__ request from an OLDER 'doc'
                                              // message, resolved after a NEWER one superseded it,
                                              // could previously return the newer document's bytes
                                              // paired with the older message's path/dir/name.
static bool g_debugSaveTest = false;         // --mdv-save-test: call SaveDocumentTo() directly
static bool g_debugExportTest = false;       // --mdv-export-test: call WriteHtmlExport() directly
                                              // once the page is ready, performing a real disk
                                              // write through the exact path a real save takes.
static bool g_debugPdfTest = false;          // --mdv-pdf-test: call WritePdfExport() directly --
                                              // asserts a longer --mdv-exit-after than the default
                                              // (see tools/regression.ps1's pdf-test scenario),
                                              // since PrintToPdf()'s completion is genuinely async.
                                              // Every existing "saveDoc" check in
                                              // debugRunEditorTest() stubs bridge.postMessage, so
                                              // none of them ever reach native at all --
                                              // g_suppressWatchUntil (the window that stops our
                                              // own save from being mistaken for an external
                                              // change and triggering a spurious reload) had
                                              // never actually been exercised.
static bool g_debugDirtyOnWatch = false;     // --mdv-dirty-on-watch: set g_dirty = true right
                                              // inside the WM_APP_WATCH handler, precisely and
                                              // deterministically simulating an edit landing
                                              // during the 150ms TIMER_RELOAD debounce -- the
                                              // exact race TryAutoReload()'s dirty/editing
                                              // re-check exists to protect against (see its own
                                              // comment), previously untestable with this
                                              // harness because it needs precise timing
                                              // injection rather than real-world race luck.
static bool g_debugModalTest = false;        // --mdv-modal-test: simulate a real IFileDialog
                                              // being open exactly when a file-watcher change
                                              // notification arrives -- deterministically lands
                                              // inside the exact window TryAutoReload()'s
                                              // g_modalDepth check exists to protect (a real
                                              // modal dialog can't be driven headlessly, so this
                                              // increments/decrements the same g_modalDepth a
                                              // real ModalScope would, on a timer standing in for
                                              // "the dialog is still up" / "the dialog just
                                              // closed", rather than needing an actual dialog).
static std::wstring g_debugWatchFail;        // --mdv-watch-fail=first|next: force one of
                                              // Watcher::ThreadProc's two early-return paths via
                                              // a real (if synthetic) Win32 API failure, not a
                                              // mocked return value -- "first" points
                                              // FindFirstChangeNotificationW at a directory that
                                              // deliberately doesn't exist; "next" hands
                                              // FindNextChangeNotification a null handle on its
                                              // first call. Both paths used to leave the Watcher's
                                              // own bookkeeping (thread_/session_) populated after
                                              // the thread self-deleted its Session, a real
                                              // use-after-free the next Stop() call would trigger;
                                              // this flag exists to exercise both deterministically
                                              // rather than relying on a real directory deletion
                                              // race that can't be timed precisely.

// Every phase transition worth timing, recorded in order. Written out as JSON
// at exit so runs can be compared programmatically instead of by reading logs
// — the difference between "this felt faster" and an actual measured delta.
struct DebugPhase { std::wstring name; double atMs; };
static std::vector<DebugPhase> g_debugPhases;
static void DebugPhaseMark(const std::wstring& name) {
    if (!g_debugHeadless) return;
    g_debugPhases.push_back({ name, ElapsedMs() });
}
#endif

// ---------------------------------------------------------------- tiny ComPtr

template <typename T>
class ComPtr {
    T* p_ = nullptr;
public:
    ComPtr() = default;
    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;
    ~ComPtr() { Reset(); }
    T** Put() { Reset(); return &p_; }
    T* Get() const { return p_; }
    T* operator->() const { return p_; }
    explicit operator bool() const { return p_ != nullptr; }
    void Reset() { if (p_) { p_->Release(); p_ = nullptr; } }
    void Attach(T* p) { Reset(); p_ = p; }
    template <typename U>
    HRESULT As(ComPtr<U>& out) const {
        if (!p_) return E_POINTER;
        return p_->QueryInterface(__uuidof(U), reinterpret_cast<void**>(out.Put()));
    }
};

// Generic WebView2 callback/event handler: every handler interface we use has
// exactly one Invoke(A, B) method.
template <typename TIface, typename TArg1, typename TArg2>
class Callback final : public TIface {
    std::function<HRESULT(TArg1, TArg2)> fn_;
    LONG ref_ = 1;
public:
    explicit Callback(std::function<HRESULT(TArg1, TArg2)> fn) : fn_(std::move(fn)) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == __uuidof(TIface) || riid == __uuidof(IUnknown)) {
            *ppv = static_cast<TIface*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&ref_); }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG r = InterlockedDecrement(&ref_);
        if (!r) delete this;
        return r;
    }
    HRESULT STDMETHODCALLTYPE Invoke(TArg1 a, TArg2 b) override { return fn_(a, b); }
};

template <typename TIface, typename TArg1, typename TArg2>
static TIface* MakeCB(std::function<HRESULT(TArg1, TArg2)> fn) {
    return new Callback<TIface, TArg1, TArg2>(std::move(fn));
}

// ---------------------------------------------------------------- global state

static HWND g_hwnd = nullptr;
static HINSTANCE g_hinst = nullptr;
static ComPtr<ICoreWebView2Environment> g_env;
static ComPtr<ICoreWebView2Controller> g_controller;
static ComPtr<ICoreWebView2> g_webview;
static bool g_webReady = false;      // JS signalled 'ready'

static std::wstring g_exePath;
static std::wstring g_docPath, g_docDir, g_docName, g_pendingNav = L"new";
static std::string  g_docUtf8;
static bool g_docPlain = false;
static bool g_haveDoc = false;

// Monotonic generation counter, bumped on every g_docUtf8 mutation (open,
// reload, new, save). The 'doc' message echoes the value that was current
// the instant it was sent; fetchAndRenderFile() (app.js) round-trips it back
// on its https://doc.local/__self__ request. The __self__ handler declines
// (409) any request whose token no longer matches g_docToken, rather than
// serving whatever g_docUtf8 currently holds -- without this, a request from
// an OLDER 'doc' message that is still in flight when a NEWER one supersedes
// it could resolve with the newer document's bytes paired with the older
// message's path/dir/name, since nothing previously tied the two together.
// Both sides run on WebView2's single UI thread, so there is no window
// between "g_docToken read" and "g_docUtf8 read" for a concurrent mutation
// to land in.
static unsigned long long g_docToken = 0;

// A real IFileDialog::Show() call pumps the message loop itself while it's
// up, so a WM_APP_WATCH -> TIMER_RELOAD -> TryAutoReload() sequence can fire
// WHILE the dialog is showing. TryAutoReload() checks this depth (see below)
// and re-arms rather than proceeding, so a change landing during a long
// dialog is deferred, not silently lost -- unlike g_dirty/g_editing, which
// this app's two MessageBoxW confirmation dialogs already guard against
// (WM_CLOSE and drag-drop's discard prompt are both only ever reachable when
// g_dirty is true, and TryAutoReload() already short-circuits on g_dirty
// before touching ReloadDoc(), so those two sites need no separate guard).
static int g_modalDepth = 0;
struct ModalScope {
    ModalScope() { g_modalDepth++; }
    ~ModalScope() { g_modalDepth--; }
};

// Editing state. The page owns the text; the shell only writes what it is
// explicitly asked to write, and never on its own initiative.
static bool g_docCrlf = false;          // original file used CRLF line endings
static bool g_docBom = false;           // original file began with a UTF-8 BOM
static mdv::TextEncoding g_docEncoding = mdv::TextEncoding::Utf8;   // what NormalizeToUtf8 found on disk
static long long g_docSize = 0;         // on-disk byte size at last load (document info, display only)
static long long g_docModifiedMs = 0;   // last-write time, Unix ms (document info, display only)
static bool g_editing = false;          // the page is showing its editor
static bool g_dirty = false;            // the page holds unsaved changes
static bool g_closeAfterSave = false;   // a save was requested by the close prompt
static ULONGLONG g_suppressWatchUntil = 0;  // ignore the change our own save causes
static bool g_warnUnsavedLossOnReady = false;  // ProcessFailed discarded unsaved edits; toast once the reload's fresh page reports ready

static bool g_dark = false;
static double g_zoom = 1.0;
static bool g_solo = true;
static HANDLE g_instanceMutex = nullptr;
static std::wstring g_udfPath;

// Debug builds get their own mutex name and WebView2 profile directory, distinct
// from the release build's, so a headless MDView.debug.exe test run never fights
// the user's real MDView.exe over single-instance detection or a locked profile.
#ifdef MDV_DEBUG
static const wchar_t* kInstanceMutexName = L"Local\\SimpleMDViewer.Instance.Debug";
static const wchar_t* kProfileDirName = L"MDView.debug.wv2";
#else
static const wchar_t* kInstanceMutexName = L"Local\\SimpleMDViewer.Instance";
static const wchar_t* kProfileDirName = L"MDView.wv2";
#endif

static bool g_fullscreen = false;
static WINDOWPLACEMENT g_preFsPlacement = { sizeof(WINDOWPLACEMENT) };
static LONG g_preFsStyle = 0;

static HBRUSH g_brushLight = nullptr, g_brushDark = nullptr;

// window placement loaded from ADS
static bool g_havePlacement = false;
static RECT g_savedRect = {};
static bool g_savedMax = false;

// ---------------------------------------------------------------- string utils

static std::wstring ToLower(std::wstring s) {
    std::transform(s.begin(), s.end(), s.begin(), towlower);
    return s;
}

static bool StartsWith(const std::wstring& s, const wchar_t* prefix) {
    size_t n = wcslen(prefix);
    return s.size() >= n && _wcsnicmp(s.c_str(), prefix, n) == 0;
}

static std::wstring ExtOf(const std::wstring& path) {
    size_t dot = path.find_last_of(L'.');
    size_t slash = path.find_last_of(L"\\/");
    if (dot == std::wstring::npos || (slash != std::wstring::npos && dot < slash)) return L"";
    return ToLower(path.substr(dot + 1));
}

// Standard base64 -> bytes, for a pasted image's data URL (see "paste" in
// app.js). No external dependency (bcrypt/crypt32) for something this small.
static bool Base64Decode(const std::string& in, std::string& out) {
    auto val = [](unsigned char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    };
    out.clear();
    out.reserve(in.size() / 4 * 3);
    int buf = 0, bits = 0;
    for (unsigned char c : in) {
        if (c == '=' || c == '\n' || c == '\r') continue;
        int v = val(c);
        if (v < 0) return false;
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += (char)((buf >> bits) & 0xFF);
        }
    }
    return true;
}

// JSON string escaping for values we send into the page.
static std::wstring JsonEscape(const std::wstring& s) {
    std::wstring o;
    o.reserve(s.size() + 16);
    for (wchar_t c : s) {
        switch (c) {
        case L'"': o += L"\\\""; break;
        case L'\\': o += L"\\\\"; break;
        case L'\n': o += L"\\n"; break;
        case L'\r': o += L"\\r"; break;
        case L'\t': o += L"\\t"; break;
        default:
            if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                wchar_t buf[8];
                swprintf(buf, 8, L"\\u%04x", (unsigned)c);
                o += buf;
            } else o += c;
        }
    }
    return o;
}

static std::wstring UrlDecode(const std::wstring& in) {
    std::string bytes;
    bytes.reserve(in.size());
    for (size_t i = 0; i < in.size(); i++) {
        if (in[i] == L'%' && i + 2 < in.size() && iswxdigit(in[i + 1]) && iswxdigit(in[i + 2])) {
            wchar_t hex[3] = { in[i + 1], in[i + 2], 0 };
            bytes += (char)wcstoul(hex, nullptr, 16);
            i += 2;
        } else if (in[i] < 128) {
            bytes += (char)in[i];
        } else {
            // Non-ASCII char that was not percent-encoded; re-encode as UTF-8.
            wchar_t one[2] = { in[i], 0 };
            bytes += Narrow(one);
        }
    }
    return Widen(bytes.data(), (int)bytes.size());
}

// Extract a "key=<digits>" query parameter's value from a full request URI.
// Returns ULLONG_MAX (never a real token -- see g_docToken) if the key is
// absent, so a request missing it outright fails the token comparison rather
// than being treated as a match.
static unsigned long long QueryParamULL(const std::wstring& uri, const wchar_t* key) {
    std::wstring pat = std::wstring(key) + L"=";
    size_t pos = uri.find(pat);
    if (pos == std::wstring::npos) return ULLONG_MAX;
    pos += pat.size();
    size_t end = uri.find_first_of(L"&#", pos);
    std::wstring val = uri.substr(pos, end == std::wstring::npos ? std::wstring::npos : end - pos);
    return wcstoull(val.c_str(), nullptr, 10);
}

// ---------------------------------------------------------------- file helpers

// FILETIME's own epoch is 1601-01-01, in 100ns intervals; JS wants a plain
// Unix-epoch millisecond number. 116444736000000000 is the well-known
// interval count between the two epochs.
static long long FileTimeToUnixMs(const FILETIME& ft) {
    ULARGE_INTEGER u;
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    return (long long)((u.QuadPart - 116444736000000000ULL) / 10000ULL);
}

// Document-info display only (size/modified shown in the F1 panel) -- a
// metadata-only query (GetFileAttributesExW), same pattern Watcher::Session
// already uses, deliberately not folded into ReadFileBytes's own handle so a
// failure here never affects whether the document itself loads.
static void GetFileSizeAndMTime(const std::wstring& path, long long& size, long long& modifiedMs) {
    WIN32_FILE_ATTRIBUTE_DATA fa{};
    if (GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &fa)) {
        size = ((long long)fa.nFileSizeHigh << 32) | fa.nFileSizeLow;
        modifiedMs = FileTimeToUnixMs(fa.ftLastWriteTime);
    } else {
        size = 0;
        modifiedMs = 0;
    }
}

static bool ReadFileBytes(const std::wstring& path, std::string& out) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(h, &size) || size.QuadPart > 512ll * 1024 * 1024) {
        CloseHandle(h);
        return false;
    }
    out.resize((size_t)size.QuadPart);
    DWORD read = 0;
    bool ok = true;
    size_t off = 0;
    while (off < out.size()) {
        DWORD chunk = (DWORD)std::min<size_t>(out.size() - off, 1 << 20);
        if (!ReadFile(h, out.data() + off, chunk, &read, nullptr) || read == 0) { ok = false; break; }
        off += read;
    }
    CloseHandle(h);
    return ok && off == out.size();
}

static bool WriteAds(const std::wstring& streamPath, const std::string& bytes) {
    HANDLE h = CreateFileW(streamPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ,
        nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    bool ok = WriteFile(h, bytes.data(), (DWORD)bytes.size(), &written, nullptr) && written == bytes.size();
    CloseHandle(h);
    return ok;
}

static bool ReadAds(const std::wstring& streamPath, std::string& out) {
    return ReadFileBytes(streamPath, out);
}

static bool LooksBinary(const std::string& bytes) {
    // A UTF-16 BOM is an explicit, unambiguous encoding marker -- the same
    // one NormalizeToUtf8 (textio.h) already trusts for decoding. A genuine
    // UTF-16 text file is roughly half null bytes by construction (every
    // other byte of any ASCII-range content), which would otherwise trip
    // the null-byte heuristic below and misidentify it as binary before it
    // ever reaches NormalizeToUtf8's UTF-16 path.
    if (bytes.size() >= 2) {
        unsigned char b0 = (unsigned char)bytes[0], b1 = (unsigned char)bytes[1];
        if ((b0 == 0xFF && b1 == 0xFE) || (b0 == 0xFE && b1 == 0xFF)) return false;
    }
    size_t probe = std::min<size_t>(bytes.size(), 8000);
    for (size_t i = 0; i < probe; i++)
        if (bytes[i] == '\0') return true;
    return false;
}

// ---------------------------------------------------------------- embedded resources

struct ResEntry { const wchar_t* path; int id; const wchar_t* mime; };
static const ResEntry kResources[] = {
    { L"index.html",  IDR_INDEX_HTML, L"text/html; charset=utf-8" },
    { L"app.css",     IDR_APP_CSS,    L"text/css; charset=utf-8" },
    { L"app.js",      IDR_APP_JS,     L"text/javascript; charset=utf-8" },
    { L"demo.md",     IDR_DEMO_MD,    L"text/markdown; charset=utf-8" },
    { L"boot.js",     IDR_APP_BOOT,   L"text/javascript; charset=utf-8" },
    { L"vendor/markdown-it.min.js",            IDR_V_MARKDOWNIT, L"text/javascript" },
    { L"vendor/markdown-it-footnote.min.js",   IDR_V_FOOTNOTE,   L"text/javascript" },
    { L"vendor/markdown-it-deflist.min.js",    IDR_V_DEFLIST,    L"text/javascript" },
    { L"vendor/markdown-it-task-lists.min.js", IDR_V_TASKLISTS,  L"text/javascript" },
    { L"vendor/markdown-it-anchor.umd.min.js", IDR_V_ANCHOR,     L"text/javascript" },
    { L"vendor/markdown-it-sub.min.js",        IDR_V_SUB,        L"text/javascript" },
    { L"vendor/markdown-it-sup.min.js",        IDR_V_SUP,        L"text/javascript" },
    { L"vendor/markdown-it-mark.min.js",       IDR_V_MARK,       L"text/javascript" },
    { L"vendor/markdown-it-ins.min.js",        IDR_V_INS,        L"text/javascript" },
    { L"vendor/markdown-it-abbr.min.js",       IDR_V_ABBR,       L"text/javascript" },
    { L"vendor/markdown-it-emoji.min.js",      IDR_V_EMOJI,      L"text/javascript" },
    { L"vendor/texmath.min.js",                IDR_V_TEXMATH,    L"text/javascript" },
    { L"vendor/purify.min.js",                 IDR_V_PURIFY,     L"text/javascript" },
    { L"vendor/highlight.min.js",              IDR_V_HIGHLIGHT,  L"text/javascript" },
    { L"vendor/katex.min.js",                  IDR_V_KATEX_JS,   L"text/javascript" },
    { L"vendor/katex.min.css",                 IDR_V_KATEX_CSS,  L"text/css" },
    { L"vendor/mermaid.min.js",                IDR_V_MERMAID,    L"text/javascript" },
    { L"vendor/mhchem.min.js",                 IDR_V_MHCHEM,     L"text/javascript" },
    { L"vendor/lang-powershell.min.js",        IDR_V_LANG_PS,    L"text/javascript" },
    { L"vendor/lang-dos.min.js",               IDR_V_LANG_DOS,   L"text/javascript" },
    { L"vendor/lang-dockerfile.min.js",        IDR_V_LANG_DOCKER,L"text/javascript" },
    { L"vendor/lang-cmake.min.js",             IDR_V_LANG_CMAKE, L"text/javascript" },
    { L"vendor/lang-x86asm.min.js",            IDR_V_LANG_X86,   L"text/javascript" },
    { L"vendor/lang-nginx.min.js",             IDR_V_LANG_NGINX, L"text/javascript" },
    { L"vendor/turndown.min.js",               IDR_V_TURNDOWN,   L"text/javascript" },
    { L"vendor/turndown-plugin-gfm.js",        IDR_V_TURNDOWN_GFM, L"text/javascript" },
    { L"md-setup.js", IDR_MD_SETUP, L"text/javascript; charset=utf-8" },
    { L"worker.js",   IDR_WORKER,   L"text/javascript; charset=utf-8" },
    { L"vendor/fonts/KaTeX_AMS-Regular.woff2",         IDR_F_AMS_R,   L"font/woff2" },
    { L"vendor/fonts/KaTeX_Caligraphic-Bold.woff2",    IDR_F_CAL_B,   L"font/woff2" },
    { L"vendor/fonts/KaTeX_Caligraphic-Regular.woff2", IDR_F_CAL_R,   L"font/woff2" },
    { L"vendor/fonts/KaTeX_Fraktur-Bold.woff2",        IDR_F_FRA_B,   L"font/woff2" },
    { L"vendor/fonts/KaTeX_Fraktur-Regular.woff2",     IDR_F_FRA_R,   L"font/woff2" },
    { L"vendor/fonts/KaTeX_Main-Bold.woff2",           IDR_F_MAIN_B,  L"font/woff2" },
    { L"vendor/fonts/KaTeX_Main-BoldItalic.woff2",     IDR_F_MAIN_BI, L"font/woff2" },
    { L"vendor/fonts/KaTeX_Main-Italic.woff2",         IDR_F_MAIN_I,  L"font/woff2" },
    { L"vendor/fonts/KaTeX_Main-Regular.woff2",        IDR_F_MAIN_R,  L"font/woff2" },
    { L"vendor/fonts/KaTeX_Math-BoldItalic.woff2",     IDR_F_MATH_BI, L"font/woff2" },
    { L"vendor/fonts/KaTeX_Math-Italic.woff2",         IDR_F_MATH_I,  L"font/woff2" },
    { L"vendor/fonts/KaTeX_SansSerif-Bold.woff2",      IDR_F_SANS_B,  L"font/woff2" },
    { L"vendor/fonts/KaTeX_SansSerif-Italic.woff2",    IDR_F_SANS_I,  L"font/woff2" },
    { L"vendor/fonts/KaTeX_SansSerif-Regular.woff2",   IDR_F_SANS_R,  L"font/woff2" },
    { L"vendor/fonts/KaTeX_Script-Regular.woff2",      IDR_F_SCRIPT_R,L"font/woff2" },
    { L"vendor/fonts/KaTeX_Size1-Regular.woff2",       IDR_F_SIZE1,   L"font/woff2" },
    { L"vendor/fonts/KaTeX_Size2-Regular.woff2",       IDR_F_SIZE2,   L"font/woff2" },
    { L"vendor/fonts/KaTeX_Size3-Regular.woff2",       IDR_F_SIZE3,   L"font/woff2" },
    { L"vendor/fonts/KaTeX_Size4-Regular.woff2",       IDR_F_SIZE4,   L"font/woff2" },
    { L"vendor/fonts/KaTeX_Typewriter-Regular.woff2",  IDR_F_TYPE_R,  L"font/woff2" },
};

static bool GetResourceBytes(int id, const void*& data, DWORD& size) {
    HRSRC hr = FindResourceW(g_hinst, MAKEINTRESOURCEW(id), (LPCWSTR)RT_RCDATA);
    if (!hr) return false;
    HGLOBAL hg = LoadResource(g_hinst, hr);
    if (!hg) return false;
    data = LockResource(hg);
    size = SizeofResource(g_hinst, hr);
    return data && size;
}

static const wchar_t* MimeForExt(const std::wstring& ext) {
    struct { const wchar_t* e; const wchar_t* m; } map[] = {
        { L"png", L"image/png" }, { L"jpg", L"image/jpeg" }, { L"jpeg", L"image/jpeg" },
        { L"jfif", L"image/jpeg" }, { L"gif", L"image/gif" }, { L"webp", L"image/webp" },
        { L"svg", L"image/svg+xml" }, { L"bmp", L"image/bmp" }, { L"ico", L"image/x-icon" },
        { L"avif", L"image/avif" }, { L"mp4", L"video/mp4" }, { L"webm", L"video/webm" },
        { L"ogg", L"audio/ogg" }, { L"mp3", L"audio/mpeg" }, { L"wav", L"audio/wav" },
        { L"m4a", L"audio/mp4" },
    };
    for (auto& e : map)
        if (ext == e.e) return e.m;
    return nullptr; // not on the media whitelist
}

// True only for a genuine drive-absolute local path ("C:\..."); false for a
// UNC path (\\server\share), a device path (\\?\, \\.\), or anything else
// that isn't drive-absolute. `full` must already be canonicalized via
// GetFullPathNameW — Windows path parsing treats '/' and '\' as equivalent
// separators, so this must never be applied to a raw, un-canonicalized
// string (GetFullPathNameW normalizes that difference away; a hand-rolled
// prefix check on the raw string would not, and a "//host/share" input
// would slip through a check that only looks for a leading "\\\\").
static bool IsLocalDrivePath(const std::wstring& full) {
    return full.size() >= 3 && full[0] != L'\\' && full[1] == L':';
}

// Confine a document-referenced file to the document's own folder subtree, and
// reject UNC (\\server\share) and device (\\?\, \\.\) paths outright. UNC paths
// are the important case: merely probing one triggers an outbound SMB/NTLM
// handshake, so an attacker-authored path like \\attacker\x could leak the
// user's credential hash the instant a malicious document opens. `full` must be
// the already-canonicalized output of GetFullPathNameW.
static bool IsSafeLocalPath(const std::wstring& full, const std::wstring& dir) {
    if (!IsLocalDrivePath(full)) return false;
    if (dir.empty()) return false;
    std::wstring d = dir;
    while (!d.empty() && (d.back() == L'\\' || d.back() == L'/')) d.pop_back();
    std::wstring lf = ToLower(full), ld = ToLower(d);
    if (lf.size() < ld.size() || lf.compare(0, ld.size(), ld) != 0) return false;
    return lf.size() == ld.size() || lf[ld.size()] == L'\\';
}

// ---------------------------------------------------------------- file watcher

// Each Start() gives its watch thread a private, heap-owned Session rather
// than pointing it at fields on the Watcher itself. FindNextChangeNotification
// can block indefinitely on some remote/mapped-drive filesystems, so a watch
// thread is not guaranteed to exit promptly when asked to stop; if Stop()'s
// wait times out, the thread is detached rather than joined. Giving every
// session its own state means a detached thread keeps running against data
// nobody else touches, instead of racing a subsequent Start() over shared
// dir_/file_ fields (a non-atomic std::wstring assignment on one thread,
// concurrent with a read on another, is undefined behavior — real risk of
// heap corruption, not just a logic glitch).
//
// Ownership split, deliberately: the Watcher owns the stop event for its
// entire lifetime; the watch thread owns only its private Session (freed via
// unique_ptr on every exit path). Earlier, the Session owned the stop event
// and the thread closed/freed both on its way out — but FindFirstChangeNotificationW
// failing, or FindNextChangeNotification failing mid-loop (both reachable:
// the watched directory gets deleted, unmounted, or its ACL denies read),
// made ThreadProc return WITHOUT going through Stop() first. Watcher::thread_
// and a since-freed Session pointer were left populated, so the next Stop()
// call (SetEvent on freed heap, through an already-closed handle) was a
// genuine use-after-free/use-after-close, not just a leak. Splitting
// ownership by KIND rather than by which side happens to finish first makes
// the invariant checkable by reading two functions: Start() either hands the
// thread a session AND records the event, or logs and gives up; Stop() only
// ever touches an event it still owns.
class Watcher {
    struct Session {
        std::wstring dir, file;
        FILETIME lastWrite{};
        LONGLONG lastSize = -1;
        HANDLE stop = nullptr;   // BORROWED from the Watcher — never closed here.

        void Snapshot() {
            WIN32_FILE_ATTRIBUTE_DATA fa{};
            std::wstring full = dir + L"\\" + file;
            if (GetFileAttributesExW(full.c_str(), GetFileExInfoStandard, &fa)) {
                lastWrite = fa.ftLastWriteTime;
                lastSize = ((LONGLONG)fa.nFileSizeHigh << 32) | fa.nFileSizeLow;
            } else {
                lastWrite = FILETIME{};
                lastSize = -1;
            }
        }
        bool Changed() {
            FILETIME oldW = lastWrite;
            LONGLONG oldS = lastSize;
            Snapshot();
            return CompareFileTime(&oldW, &lastWrite) != 0 || oldS != lastSize;
        }
    };

    HANDLE thread_ = nullptr;
    HANDLE stop_ = nullptr;   // owned by the Watcher for its entire lifetime

    // Takes ownership of `s` via unique_ptr — freed on every exit path,
    // including the two early-return paths that used to leave the Watcher's
    // own bookkeeping dangling. Never closes s->stop; that handle belongs to
    // the Watcher and outlives this function on every path.
    static DWORD WINAPI ThreadProc(LPVOID param) {
        std::unique_ptr<Session> s((Session*)param);
        std::wstring watchDir = s->dir;
#ifdef MDV_DEBUG
        if (g_debugHeadless && g_debugWatchFail == L"first")
            watchDir += L"\\__mdv-watch-fail-first__";   // deliberately nonexistent
#endif
        HANDLE change = FindFirstChangeNotificationW(watchDir.c_str(), FALSE,
            FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_FILE_NAME |
            FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_ATTRIBUTES);
        if (change == INVALID_HANDLE_VALUE) {
#ifdef MDV_DEBUG
            if (g_debugHeadless && g_debugWatchFail == L"first")
                AppendLog(L"watch-fail-test: FindFirstChangeNotificationW failed as expected (first), thread exiting early");
#endif
            return 0;
        }
        HANDLE handles[2] = { s->stop, change };
        for (;;) {
            DWORD w = WaitForMultipleObjects(2, handles, FALSE, INFINITE);
            if (w != WAIT_OBJECT_0 + 1) break;
            if (s->Changed())
                PostMessageW(g_hwnd, WM_APP_WATCH, 0, 0);
            HANDLE nextArg = change;
#ifdef MDV_DEBUG
            if (g_debugHeadless && g_debugWatchFail == L"next") nextArg = nullptr;
#endif
            if (!FindNextChangeNotification(nextArg)) {
#ifdef MDV_DEBUG
                if (g_debugHeadless && g_debugWatchFail == L"next")
                    AppendLog(L"watch-fail-test: FindNextChangeNotification failed as expected (next), thread exiting early");
#endif
                break;
            }
        }
        FindCloseChangeNotification(change);
        return 0;
    }

public:
    void Start(const std::wstring& dir, const std::wstring& file) {
        Stop();
        HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!stop) {
            AppendLog(L"Watcher::Start: CreateEventW failed; live reload disabled for this document");
            return;
        }
        auto s = std::make_unique<Session>();
        s->dir = dir;
        s->file = file;
        s->Snapshot();
        s->stop = stop;
        HANDLE t = CreateThread(nullptr, 0, ThreadProc, s.get(), 0, nullptr);
        if (!t) {
            AppendLog(L"Watcher::Start: CreateThread failed; live reload disabled for this document");
            CloseHandle(stop);
            return;   // s (unique_ptr) frees the session on scope exit
        }
        s.release();   // ThreadProc now owns the session
        stop_ = stop;
        thread_ = t;
    }
    void Stop() {
        if (!thread_) return;
        SetEvent(stop_);   // always a live, Watcher-owned handle — never freed elsewhere
        if (WaitForSingleObject(thread_, 2000) != WAIT_OBJECT_0) {
            // Didn't exit in time — most likely blocked in
            // FindNextChangeNotification on an unresponsive remote/mapped
            // drive. Detach rather than block indefinitely or risk killing a
            // thread mid-syscall. stop_ is deliberately LEAKED here rather
            // than closed: the detached thread may still reference it inside
            // WaitForMultipleObjects' handle array, and closing a handle a
            // running wait still holds is the exact use-after-close class of
            // bug this rewrite exists to eliminate. Cost: one leaked event
            // handle per unresponsive volume, for the rest of the process's
            // life — bounded, and a real trade against genuine UB.
            AppendLog(L"Watcher::Stop: watch thread did not exit in time; detaching it");
            CloseHandle(thread_);
            thread_ = nullptr;
            stop_ = nullptr;
            return;
        }
        CloseHandle(thread_);
        CloseHandle(stop_);
        thread_ = nullptr;
        stop_ = nullptr;
    }
    ~Watcher() { Stop(); }
};
static Watcher g_watcher;

// ---------------------------------------------------------------- messaging to page

static void PostJson(const std::wstring& json) {
    if (g_webview) g_webview->PostWebMessageAsJson(json.c_str());
}

static void SendToast(const std::wstring& text) {
    PostJson(L"{\"type\":\"toast\",\"text\":\"" + JsonEscape(text) + L"\"}");
}

static void SendCmd(const wchar_t* cmd) {
    PostJson(std::wstring(L"{\"type\":\"cmd\",\"cmd\":\"") + cmd + L"\"}");
}

static void SendDocMsg(const std::wstring& nav) {
    // bom/crlf/encoding/size/modified: document info shown in the F1 panel
    // (docs/BACKLOG.md's Features #10) -- native already tracked bom/crlf
    // for save-time preservation and had never sent them to the page.
    std::wstring j = L"{\"type\":\"doc\",\"name\":\"" + JsonEscape(g_docName) +
        L"\",\"path\":\"" + JsonEscape(g_docPath) +
        L"\",\"dir\":\"" + JsonEscape(g_docDir) +
        L"\",\"plain\":\"" + (g_docPlain ? L"1" : L"0") +
        L"\",\"nav\":\"" + JsonEscape(nav) +
        L"\",\"tok\":\"" + std::to_wstring(g_docToken) +
        L"\",\"bom\":\"" + (g_docBom ? L"1" : L"0") +
        L"\",\"crlf\":\"" + (g_docCrlf ? L"1" : L"0") +
        L"\",\"encoding\":\"" + JsonEscape(mdv::TextEncodingLabel(g_docEncoding)) +
        L"\",\"size\":\"" + std::to_wstring(g_docSize) +
        L"\",\"modified\":\"" + std::to_wstring(g_docModifiedMs) + L"\"}";
    PostJson(j);
#ifdef MDV_DEBUG
    if (g_debugHeadless) AppendLog(L"doc-info: encoding=\"" + std::wstring(mdv::TextEncodingLabel(g_docEncoding)) +
        L"\" bom=" + (g_docBom ? L"1" : L"0") + L" crlf=" + (g_docCrlf ? L"1" : L"0") +
        L" size=" + std::to_wstring(g_docSize) + L" modified=" + std::to_wstring(g_docModifiedMs));
#endif
}

static void SendNoDoc() {
    PostJson(L"{\"type\":\"nodoc\"}");
}

// ---------------------------------------------------------------- document loading

static bool IsMarkdownExt(const std::wstring& ext) {
    static const wchar_t* mdExts[] = { L"md", L"markdown", L"mdown", L"mkd", L"mkdn", L"mdwn", L"mdtxt", L"rmd", L"qmd", L"" };
    for (auto e : mdExts)
        if (ext == e) return true;
    return false;
}

static void UpdateTitle() {
    std::wstring t = g_haveDoc ? (g_docName + L" \u2014 " + kAppTitle) : kAppTitle;
    if (g_dirty) t = L"\u2022 " + t;   // a bullet marks unsaved changes
    SetWindowTextW(g_hwnd, t.c_str());
#ifdef MDV_DEBUG
    if (g_debugHeadless) AppendLog(L"title-now: \"" + t + L"\"");
#endif
}

// Save `text` (LF-separated UTF-8 from the page) to `path`.
static bool SaveDocumentTo(const std::wstring& path, const std::string& textLf) {
    // Apply the line-ending convention ONCE here rather than letting
    // WriteTextFile redo the same full-document CRLF pass independently: pass
    // it the already-converted text with crlf=false (a no-op given that) and
    // only g_docBom left for it to apply -- a cheap 3-byte prefix, not
    // another O(n) scan.
    std::string converted = ApplyTextConventions(textLf, g_docCrlf, false);
    std::wstring error;
    if (!WriteTextFile(path, converted, false, g_docBom, error)) {
        SendToast(L"Not saved. " + error);
        PostJson(L"{\"type\":\"saveFailed\"}");
        return false;
    }
    // Keep the in-memory copy in step, and ignore the change notification our
    // own write is about to produce. No BOM here: g_docUtf8 is the in-memory
    // cache compared against future watcher reads, not the on-disk bytes
    // (WriteTextFile applied g_docBom separately to what actually got written).
    g_docUtf8 = std::move(converted);
    g_docToken++;
    g_suppressWatchUntil = GetTickCount64() + 1500;
    g_dirty = false;
    UpdateTitle();
    PostJson(L"{\"type\":\"saved\",\"path\":\"" + JsonEscape(path) + L"\"}");
    return true;
}

// Every failure path reports its own reason via toast before returning false,
// so callers should NOT also toast a generic fallback on failure — that would
// just overwrite whichever of these messages actually explains what happened
// (toast() replaces the visible toast outright; there's no stacking).
static bool OpenDocument(const std::wstring& rawPath, const std::wstring& nav) {
    wchar_t full[4096];
    DWORD n = GetFullPathNameW(rawPath.c_str(), 4096, full, nullptr);
    if (!n || n >= 4096) {
        SendToast(L"Could not open that file.");
        return false;
    }
    std::wstring path = full;
    // Windows paths are case-insensitive but case-preserving, and
    // GetFullPathNameW only resolves lexically (., .., relative segments) —
    // it doesn't correct casing to match what's actually on disk. Without
    // this, the same file opened once directly and once via a differently-
    // cased relative link produces two distinct path strings, which the
    // plain string comparisons in recent-files dedup and remembered scroll
    // positions then treat as two different files. GetFinalPathNameByHandleW
    // (not GetLongPathNameW — tried first, but it only reliably corrects
    // directory components, not the final path segment) resolves the
    // definitive, correctly-cased path for an actual open handle. Best-
    // effort and narrowly scoped: only the common local-drive "\\?\C:\..."
    // shape is trusted; anything else (a UNC share, an unexpected prefix)
    // just keeps the GetFullPathNameW result, no worse than before.
    HANDLE ch = CreateFileW(path.c_str(), GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (ch != INVALID_HANDLE_VALUE) {
        wchar_t canon[4096];
        DWORD cn = GetFinalPathNameByHandleW(ch, canon, 4096, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        CloseHandle(ch);
        if (cn && cn < 4096 && cn > 6 &&
            wcsncmp(canon, L"\\\\?\\", 4) == 0 && iswalpha(canon[4]) && canon[5] == L':') {
            path = canon + 4;
        }
    }

    std::string bytes;
    bool ok = false;
    for (int attempt = 0; attempt < 4 && !ok; attempt++) {
        ok = ReadFileBytes(path, bytes);
        if (!ok) Sleep(60); // editors replace files via rename; give them a beat
    }
    if (!ok) {
        SendToast(L"Could not open that file.");
        return false;
    }
    if (LooksBinary(bytes)) {
        SendToast(L"That file looks like a binary file, not a text document.");
        return false;
    }

    // Remember how the file is written so saving preserves its conventions.
    g_docUtf8 = NormalizeToUtf8(std::move(bytes), &g_docEncoding);
    g_docBom = g_docEncoding == mdv::TextEncoding::Utf8Bom;
    g_docToken++;
    g_docCrlf = g_docUtf8.find("\r\n") != std::string::npos;
    g_docPath = path;
    size_t slash = path.find_last_of(L"\\/");
    g_docDir = slash == std::wstring::npos ? path : path.substr(0, slash);
    g_docName = slash == std::wstring::npos ? path : path.substr(slash + 1);
    g_docPlain = !IsMarkdownExt(ExtOf(path));
    g_haveDoc = true;
    g_pendingNav = nav;
    g_dirty = false;
    g_editing = false;
    GetFileSizeAndMTime(path, g_docSize, g_docModifiedMs);

    UpdateTitle();
    g_watcher.Start(g_docDir, g_docName);
    if (g_webReady) SendDocMsg(nav);
#ifdef MDV_DEBUG
    // Generic success signal for every OpenDocument() caller (CLI arg,
    // drag-drop, recent-file click, link click, JS-driven session restore) --
    // added specifically so tools/regression.ps1 can prove a *particular*
    // caller genuinely reached this point, not just that some doc ended up
    // open (nav distinguishes callers: session restore always sends "new").
    if (g_debugHeadless) AppendLog(L"opened: " + path + L" nav=" + nav);
#endif
    return true;
}

static void ReloadDoc(const wchar_t* nav = L"reload") {
    if (!g_haveDoc) return;
    std::string bytes;
    bool ok = false;
    for (int attempt = 0; attempt < 4 && !ok; attempt++) {
        ok = ReadFileBytes(g_docPath, bytes);
        if (!ok) Sleep(60);
    }
    if (!ok) {
        SendToast(L"The file was moved or deleted. Showing the last loaded version.");
        return;
    }
    if (LooksBinary(bytes)) return;
    g_docUtf8 = NormalizeToUtf8(std::move(bytes), &g_docEncoding);
    g_docBom = g_docEncoding == mdv::TextEncoding::Utf8Bom;
    g_docToken++;
    g_docCrlf = g_docUtf8.find("\r\n") != std::string::npos;
    g_dirty = false;
    GetFileSizeAndMTime(g_docPath, g_docSize, g_docModifiedMs);
    UpdateTitle();
    if (g_webReady) SendDocMsg(nav);
}

// Shared reload gate for the file watcher. Re-checks dirty/editing state
// right here rather than only when the change notification first arrived —
// WM_APP_WATCH debounces 150ms before this runs, which is enough time for
// the reader to start editing or make an unsaved change, the very thing
// this exists to protect against. Not used by the F5 "discard mine, reload"
// path, which is a deliberate user choice and correctly bypasses this.
static void TryAutoReload() {
    if (g_modalDepth > 0) {
        // A real IFileDialog::Show() is up right now (see g_modalDepth's
        // comment) -- re-arm the same debounce timer rather than dropping
        // this reload. TIMER_RELOAD's own handler already KillTimer()'d
        // before calling here, so nothing double-fires; when the dialog
        // finally closes, the next 150ms tick re-checks with fresh state.
        SetTimer(g_hwnd, TIMER_RELOAD, 150, nullptr);
        return;
    }
    if (g_dirty) {
        SendToast(L"This file changed on disk. Your unsaved edits are safe — "
                  L"save to overwrite them, or press F5 to discard yours.");
        return;
    }
    if (g_editing) return;
    ReloadDoc();
}

// Ask the user where to put a copy, then write it there and follow it.
// Returns true only if something was actually written.
static bool SaveDocumentAs(const std::string& textLf) {
    ComPtr<IFileSaveDialog> dlg;
    if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(dlg.Put())))) return false;
    COMDLG_FILTERSPEC filters[] = {
        { L"Markdown document", L"*.md" },
        { L"Text document", L"*.txt" },
        { L"All files", L"*.*" },
    };
    dlg->SetFileTypes(3, filters);
    dlg->SetTitle(L"Save a copy");
    dlg->SetDefaultExtension(L"md");
    if (g_haveDoc) {
        dlg->SetFileName(g_docName.c_str());
        ComPtr<IShellItem> folder;
        if (SUCCEEDED(SHCreateItemFromParsingName(g_docDir.c_str(), nullptr, IID_PPV_ARGS(folder.Put()))))
            dlg->SetFolder(folder.Get());
    }
    DWORD opts = 0;
    dlg->GetOptions(&opts);
    dlg->SetOptions(opts | FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT);
    HRESULT showHr;
    { ModalScope modal; showHr = dlg->Show(g_hwnd); }
    if (FAILED(showHr)) return false;   // user cancelled

    ComPtr<IShellItem> item;
    if (FAILED(dlg->GetResult(item.Put()))) return false;
    PWSTR raw = nullptr;
    if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &raw)) || !raw) return false;
    std::wstring target = raw;
    CoTaskMemFree(raw);

    std::wstring error;
    if (!WriteTextFile(target, textLf, g_docCrlf, g_docBom, error)) {
        SendToast(L"Not saved. " + error);
        PostJson(L"{\"type\":\"saveFailed\"}");
        return false;
    }
    g_dirty = false;
    // Continue working in the copy, the way editors normally behave.
    if (!OpenDocument(target, L"new"))
        SendToast(L"Saved, but the copy could not be reopened.");
    PostJson(L"{\"type\":\"saved\",\"path\":\"" + JsonEscape(target) + L"\"}");
    return true;
}

// The actual write, factored out of the dialog flow below so
// --mdv-export-test can prove it directly -- same split SaveDocumentTo/
// SaveDocumentAs already have, since a real IFileSaveDialog::Show() can't
// be driven headlessly (nobody to click it).
static bool WriteHtmlExport(const std::wstring& target, const std::string& htmlUtf8) {
    std::wstring error;
    if (!WriteTextFile(target, htmlUtf8, false, false, error)) {
        SendToast(L"Export failed. " + error);
        return false;
    }
    SendToast(L"Exported to " + target);
    return true;
}

// "Export as HTML" (docs/BACKLOG.md's Features #2) -- a standalone copy, not
// the document itself: never reopened as the current file (unlike
// SaveDocumentAs), no line-ending/BOM preservation (a brand-new file, not a
// rewrite of the original's own conventions), and today's own dirty state
// is untouched either way.
static bool ExportHtml(const std::string& htmlUtf8) {
    ComPtr<IFileSaveDialog> dlg;
    if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(dlg.Put())))) return false;
    COMDLG_FILTERSPEC filters[] = {
        { L"HTML document", L"*.html" },
        { L"All files", L"*.*" },
    };
    dlg->SetFileTypes(2, filters);
    dlg->SetTitle(L"Export as HTML");
    dlg->SetDefaultExtension(L"html");
    if (g_haveDoc) {
        std::wstring base = g_docName;
        size_t dot = base.find_last_of(L'.');
        if (dot != std::wstring::npos) base = base.substr(0, dot);
        if (base.empty()) base = L"document";
        dlg->SetFileName((base + L".html").c_str());
        if (!g_docDir.empty()) {
            ComPtr<IShellItem> folder;
            if (SUCCEEDED(SHCreateItemFromParsingName(g_docDir.c_str(), nullptr, IID_PPV_ARGS(folder.Put()))))
                dlg->SetFolder(folder.Get());
        }
    }
    DWORD opts = 0;
    dlg->GetOptions(&opts);
    dlg->SetOptions(opts | FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT);
    HRESULT showHr;
    { ModalScope modal; showHr = dlg->Show(g_hwnd); }
    if (FAILED(showHr)) return false;   // user cancelled

    ComPtr<IShellItem> item;
    if (FAILED(dlg->GetResult(item.Put()))) return false;
    PWSTR raw = nullptr;
    if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &raw)) || !raw) return false;
    std::wstring target = raw;
    CoTaskMemFree(raw);

    return WriteHtmlExport(target, htmlUtf8);
}

// PrintToPdf() (ICoreWebView2_7) is genuinely async -- unlike WriteHtmlExport,
// there's no synchronous write to prove directly, so --mdv-pdf-test's job is
// just confirming this got called and the completion handler eventually
// fires; the file existing afterward is what actually proves the write
// happened. Split out from ExportPdf() below for the same reason
// WriteHtmlExport is split from ExportHtml -- a real IFileSaveDialog::Show()
// can't be driven headlessly.
static void WritePdfExport(const std::wstring& target) {
    ComPtr<ICoreWebView2_7> webview7;
    if (FAILED(g_webview.As(webview7)) || !webview7.Get()) {
        SendToast(L"PDF export is not supported by this WebView2 runtime.");
        return;
    }
    webview7.Get()->PrintToPdf(target.c_str(), nullptr,
        MakeCB<ICoreWebView2PrintToPdfCompletedHandler, HRESULT, BOOL>(
            [target](HRESULT errorCode, BOOL result) -> HRESULT {
                if (FAILED(errorCode) || !result) {
                    wchar_t buf[160];
                    swprintf(buf, 160, L"PDF export failed. (hr=0x%08X)", (unsigned)errorCode);
                    SendToast(buf);
                    wchar_t logBuf[128];
                    swprintf(logBuf, 128, L"PrintToPdf completed: errorCode=0x%08X result=0", (unsigned)errorCode);
                    AppendLog(logBuf);
                } else {
                    SendToast(L"Exported to " + target);
                    AppendLog(L"PrintToPdf completed: errorCode=0x0 result=1");
                }
                return S_OK;
            }));
}

// "Export as PDF" -- the same real IFileSaveDialog flow as ExportHtml, but
// native does the actual work itself (WebView2's own print pipeline, the
// same one Ctrl+P already reaches via the OS print dialog) rather than
// writing a page-built payload, so there's no html argument to plumb through.
static void ExportPdf() {
    ComPtr<IFileSaveDialog> dlg;
    if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(dlg.Put())))) return;
    COMDLG_FILTERSPEC filters[] = {
        { L"PDF document", L"*.pdf" },
        { L"All files", L"*.*" },
    };
    dlg->SetFileTypes(2, filters);
    dlg->SetTitle(L"Export as PDF");
    dlg->SetDefaultExtension(L"pdf");
    if (g_haveDoc) {
        std::wstring base = g_docName;
        size_t dot = base.find_last_of(L'.');
        if (dot != std::wstring::npos) base = base.substr(0, dot);
        if (base.empty()) base = L"document";
        dlg->SetFileName((base + L".pdf").c_str());
        if (!g_docDir.empty()) {
            ComPtr<IShellItem> folder;
            if (SUCCEEDED(SHCreateItemFromParsingName(g_docDir.c_str(), nullptr, IID_PPV_ARGS(folder.Put()))))
                dlg->SetFolder(folder.Get());
        }
    }
    DWORD opts = 0;
    dlg->GetOptions(&opts);
    dlg->SetOptions(opts | FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT);
    HRESULT showHr;
    { ModalScope modal; showHr = dlg->Show(g_hwnd); }
    if (FAILED(showHr)) return;   // user cancelled

    ComPtr<IShellItem> item;
    if (FAILED(dlg->GetResult(item.Put()))) return;
    PWSTR raw = nullptr;
    if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &raw)) || !raw) return;
    std::wstring target = raw;
    CoTaskMemFree(raw);

    WritePdfExport(target);
}

// ---------------------------------------------------------------- preferences (ADS)

static void SaveWindowAds() {
    WINDOWPLACEMENT wp = { sizeof(WINDOWPLACEMENT) };
    if (g_fullscreen) wp = g_preFsPlacement;
    else GetWindowPlacement(g_hwnd, &wp);
    RECT r = wp.rcNormalPosition;
    char buf[256];
    snprintf(buf, sizeof(buf), "1|%ld|%ld|%ld|%ld|%d|%d|%d",
        r.left, r.top, r.right - r.left, r.bottom - r.top,
        wp.showCmd == SW_SHOWMAXIMIZED ? 1 : 0,
        (int)(g_zoom * 1000.0 + 0.5), g_dark ? 1 : 0);
    WriteAds(g_exePath + kAdsWindow, buf);
}

static void LoadWindowAds() {
    std::string s;
    if (!ReadAds(g_exePath + kAdsWindow, s)) return;
    long x, y, w, h;
    int maxed, zoom1000, dark;
    if (sscanf_s(s.c_str(), "1|%ld|%ld|%ld|%ld|%d|%d|%d", &x, &y, &w, &h, &maxed, &zoom1000, &dark) == 7) {
        RECT r = { x, y, x + w, y + h };
        if (w >= 300 && h >= 200 && MonitorFromRect(&r, MONITOR_DEFAULTTONULL)) {
            g_savedRect = r;
            g_savedMax = maxed != 0;
            g_havePlacement = true;
        }
        g_zoom = std::clamp(zoom1000 / 1000.0, 0.4, 4.0);
        g_dark = dark != 0;
    }
}

static std::string g_settingsBlob; // JS-owned settings JSON, passed through opaquely

static void LoadSettingsBlob() {
    std::string s;
    if (ReadAds(g_exePath + kAdsSettings, s) && !s.empty() && s.size() < 256 * 1024)
        g_settingsBlob = std::move(s);
}

// ---------------------------------------------------------------- shell helpers

static void OpenExternal(const std::wstring& url) {
    if (StartsWith(url, L"http://") || StartsWith(url, L"https://") || StartsWith(url, L"mailto:")) {
        ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    }
#ifdef MDV_DEBUG
    else if (g_debugHeadless) {
        // The scheme allowlist above is a real security guard -- without it,
        // a crafted link in an untrusted document (javascript:, file:, a
        // registered custom protocol handler, ...) could reach
        // ShellExecuteW. Only the rejection path is safe to verify from an
        // automated test: the allowed branch genuinely launches the user's
        // default browser/mail client, a real, visible, disruptive side
        // effect this suite must never trigger.
        AppendLog(L"openExternal: rejected (unsupported scheme) url=\"" + url + L"\"");
    }
#endif
}

static void RevealInExplorer(const std::wstring& path) {
    PIDLIST_ABSOLUTE pidl = ILCreateFromPathW(path.c_str());
    if (pidl) {
        SHOpenFolderAndSelectItems(pidl, 0, nullptr, 0);
        ILFree(pidl);
    }
}

static void OpenLocalNonMarkdown(const std::wstring& path) {
    // Passive document types open with their default app; anything else
    // (executables, scripts, archives...) is only revealed in Explorer.
    static const wchar_t* passive[] = { L"pdf", L"txt", L"csv", L"json", L"xml", L"html", L"htm",
        L"png", L"jpg", L"jpeg", L"gif", L"webp", L"svg", L"bmp",
        L"docx", L"doc", L"xlsx", L"xls", L"pptx", L"ppt", L"rtf" };
    std::wstring ext = ExtOf(path);
    for (auto e : passive) {
        if (ext == e) {
            ShellExecuteW(nullptr, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
            return;
        }
    }
    RevealInExplorer(path);
}

static void ShowOpenDialog() {
    ComPtr<IFileOpenDialog> dlg;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(dlg.Put())))) return;
    COMDLG_FILTERSPEC filters[] = {
        { L"Markdown documents", L"*.md;*.markdown;*.mdown;*.mkd;*.mkdn;*.mdwn;*.txt;*.text" },
        { L"All files", L"*.*" },
    };
    dlg->SetFileTypes(2, filters);
    dlg->SetTitle(L"Open a Markdown document");
    DWORD opts = 0;
    dlg->GetOptions(&opts);
    dlg->SetOptions(opts | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST);
    if (g_haveDoc && !g_docDir.empty()) {
        ComPtr<IShellItem> folder;
        if (SUCCEEDED(SHCreateItemFromParsingName(g_docDir.c_str(), nullptr, IID_PPV_ARGS(folder.Put()))))
            dlg->SetFolder(folder.Get());
    }
    HRESULT showHr;
    { ModalScope modal; showHr = dlg->Show(g_hwnd); }
    if (SUCCEEDED(showHr)) {
        ComPtr<IShellItem> item;
        if (SUCCEEDED(dlg->GetResult(item.Put()))) {
            PWSTR path = nullptr;
            if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path) {
                OpenDocument(path, L"new");   // reports its own failure reason
                CoTaskMemFree(path);
            }
        }
    }
}

// ---------------------------------------------------------------- theming / window

static void ApplyChrome() {
    BOOL dark = g_dark ? TRUE : FALSE;
    DwmSetWindowAttribute(g_hwnd, 20 /*DWMWA_USE_IMMERSIVE_DARK_MODE*/, &dark, sizeof(dark));
    if (g_controller) {
        ComPtr<ICoreWebView2Controller2> c2;
        if (SUCCEEDED(g_controller.As(c2))) {
            COREWEBVIEW2_COLOR bg = g_dark
                ? COREWEBVIEW2_COLOR{ 255, 0x15, 0x18, 0x1c }
                : COREWEBVIEW2_COLOR{ 255, 0xff, 0xff, 0xff };
            c2->put_DefaultBackgroundColor(bg);
        }
    }
    InvalidateRect(g_hwnd, nullptr, TRUE);
}

static void ToggleFullscreen() {
    if (!g_fullscreen) {
        g_preFsPlacement.length = sizeof(WINDOWPLACEMENT);
        GetWindowPlacement(g_hwnd, &g_preFsPlacement);
        g_preFsStyle = GetWindowLongW(g_hwnd, GWL_STYLE);
        MONITORINFO mi = { sizeof(mi) };
        GetMonitorInfoW(MonitorFromWindow(g_hwnd, MONITOR_DEFAULTTONEAREST), &mi);
        SetWindowLongW(g_hwnd, GWL_STYLE, (g_preFsStyle & ~WS_OVERLAPPEDWINDOW) | WS_POPUP);
        SetWindowPos(g_hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top,
            mi.rcMonitor.right - mi.rcMonitor.left, mi.rcMonitor.bottom - mi.rcMonitor.top,
            SWP_FRAMECHANGED | SWP_NOOWNERZORDER);
        g_fullscreen = true;
    } else {
        SetWindowLongW(g_hwnd, GWL_STYLE, g_preFsStyle);
        SetWindowPlacement(g_hwnd, &g_preFsPlacement);
        SetWindowPos(g_hwnd, nullptr, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
        g_fullscreen = false;
    }
    PostJson(std::wstring(L"{\"type\":\"fs\",\"on\":\"") + (g_fullscreen ? L"1" : L"0") + L"\"}");
}

static void SetZoom(double z) {
    g_zoom = std::clamp(z, 0.4, 4.0);
    if (g_controller) g_controller->put_ZoomFactor(g_zoom);
    PostJson(L"{\"type\":\"zoom\",\"v\":\"" + std::to_wstring((int)(g_zoom * 100 + 0.5)) + L"\"}");
}

// ---------------------------------------------------------------- web resource router

// Every failure path here used to be silently swallowed: a failed
// ServeBytes/ServeStatus means WebView2 falls through to whatever the real
// network resolves app.local/doc.local to (nothing -- they're synthetic),
// so the page gets a blank or half-built resource with zero diagnostic
// trail. No toast on any of these -- a page that can't load its own assets
// can't reliably show one -- but AppendLog always writes to disk regardless
// of build type (see CrashHandler's own use of it), so at least the log
// records WHERE and WHY a resource silently failed to load.
static HRESULT ServeBytes(ICoreWebView2WebResourceRequestedEventArgs* args,
                          const void* data, DWORD size, const wchar_t* mime, bool cache) {
    ComPtr<IStream> stream;
    stream.Attach(SHCreateMemStream((const BYTE*)data, size));
    if (!stream) {
        wchar_t buf[128];
        swprintf(buf, 128, L"ServeBytes: SHCreateMemStream failed (out of memory?) mime=%s size=%lu", mime, size);
        AppendLog(buf);
        return E_FAIL;
    }
    std::wstring headers = std::wstring(L"Content-Type: ") + mime +
        L"\r\nAccess-Control-Allow-Origin: https://app.local" +
        (cache ? L"\r\nCache-Control: max-age=3600" : L"\r\nCache-Control: no-cache");
    ComPtr<ICoreWebView2WebResourceResponse> response;
    HRESULT hr = g_env->CreateWebResourceResponse(stream.Get(), 200, L"OK", headers.c_str(), response.Put());
    if (FAILED(hr)) {
        wchar_t buf[160];
        swprintf(buf, 160, L"ServeBytes: CreateWebResourceResponse failed hr=0x%08X mime=%s", (unsigned)hr, mime);
        AppendLog(buf);
        return hr;
    }
    hr = args->put_Response(response.Get());
    if (FAILED(hr)) {
        wchar_t buf[96];
        swprintf(buf, 96, L"ServeBytes: put_Response failed hr=0x%08X", (unsigned)hr);
        AppendLog(buf);
    }
    return hr;
}

static void ServeStatus(ICoreWebView2WebResourceRequestedEventArgs* args, int code, const wchar_t* reason) {
    ComPtr<ICoreWebView2WebResourceResponse> response;
    HRESULT hr = g_env->CreateWebResourceResponse(nullptr, code, reason,
        L"Access-Control-Allow-Origin: https://app.local", response.Put());
    if (FAILED(hr)) {
        wchar_t buf[128];
        swprintf(buf, 128, L"ServeStatus(%d): CreateWebResourceResponse failed hr=0x%08X", code, (unsigned)hr);
        AppendLog(buf);
        return;
    }
    hr = args->put_Response(response.Get());
    if (FAILED(hr)) {
        wchar_t buf[96];
        swprintf(buf, 96, L"ServeStatus(%d): put_Response failed hr=0x%08X", code, (unsigned)hr);
        AppendLog(buf);
    }
}

static void HandleWebResource(ICoreWebView2WebResourceRequestedEventArgs* args) {
    ComPtr<ICoreWebView2WebResourceRequest> request;
    if (FAILED(args->get_Request(request.Put())) || !request) return;
    LPWSTR uriRaw = nullptr;
    if (FAILED(request->get_Uri(&uriRaw)) || !uriRaw) return;
    std::wstring uri = uriRaw;
    CoTaskMemFree(uriRaw);

    // strip query and fragment
    std::wstring bare = uri;
    size_t q = bare.find_first_of(L"?#");
    if (q != std::wstring::npos) bare = bare.substr(0, q);

    if (StartsWith(bare, kAppOrigin)) {
        std::wstring path = bare.substr(wcslen(kAppOrigin));
        if (path.empty()) path = L"index.html";
        for (auto& r : kResources) {
            if (_wcsicmp(path.c_str(), r.path) == 0) {
                const void* data = nullptr;
                DWORD size = 0;
                if (GetResourceBytes(r.id, data, size)) {
                    bool cache = StartsWith(path, L"vendor/");
                    ServeBytes(args, data, size, r.mime, cache);
                    return;
                }
            }
        }
        ServeStatus(args, 404, L"Not Found");
        return;
    }

    if (StartsWith(bare, kDocOrigin)) {
        std::wstring path = bare.substr(wcslen(kDocOrigin));
        if (path == L"__self__") {
            // See g_docToken's comment: decline rather than serve if this
            // request was built from a 'doc' message a newer one has since
            // superseded -- the caller (fetchAndRenderFile in app.js) treats
            // a non-OK response as stale and does nothing, since a fresh
            // request for the current token was already sent alongside it.
            if (QueryParamULL(uri, L"tok") != g_docToken) {
                ServeStatus(args, 409, L"Conflict");
                return;
            }
            ServeBytes(args, g_docUtf8.data(), (DWORD)g_docUtf8.size(),
                L"text/markdown; charset=utf-8", false);
            return;
        }
        if (StartsWith(path, L"__abs__/")) {
            std::wstring fsPath = UrlDecode(path.substr(8));
            std::replace(fsPath.begin(), fsPath.end(), L'/', L'\\');
            wchar_t full[4096];
            DWORD n = GetFullPathNameW(fsPath.c_str(), 4096, full, nullptr);
            if (n && n < 4096 && IsSafeLocalPath(full, g_docDir)) {
                const wchar_t* mime = MimeForExt(ExtOf(full));
                DWORD attrs = GetFileAttributesW(full);
                if (mime && attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
                    std::string bytes;
                    if (ReadFileBytes(full, bytes)) {
                        ServeBytes(args, bytes.data(), (DWORD)bytes.size(), mime, true);
                        return;
                    }
                }
            }
            ServeStatus(args, 404, L"Not Found");
            return;
        }
        ServeStatus(args, 403, L"Forbidden");
        return;
    }
}

// ---------------------------------------------------------------- page messages

static void HandleWebMessage(const std::wstring& json) {
    std::wstring type;
    if (!JsonGetString(json, L"type", type)) return;

    if (type == L"ready") {
        g_webReady = true;
#ifdef MDV_DEBUG
        if (g_debugHeadless) AppendLog(L"webview ready, handing off doc=" + (g_haveDoc ? g_docPath : L"(none)"));
        DebugPhaseMark(L"page-ready");
        if (g_debugHeadless && g_debugCrashTest == L"seh") {
            // Deliberately trigger a real EXCEPTION_ACCESS_VIOLATION so
            // SetUnhandledExceptionFilter's CrashHandler() genuinely runs
            // (not simulated) -- verifies it fires and logs correctly, since
            // no other debug flag ever exercises this path.
            volatile int* p = nullptr;
            *p = 1;
        } else if (g_debugHeadless && g_debugCrashTest == L"terminate") {
            // Same idea for TerminateHandler(): calling std::terminate()
            // directly exercises exactly the handler std::set_terminate()
            // installed, without needing to construct an artificial
            // noexcept-violation just to reach the same place.
            std::terminate();
        }
        if (g_debugHeadless && g_debugFatalErrorTest) {
            // Mirrors exactly how a real WebView2 init-failure call site
            // uses this: log, then quit -- never falls through to the rest
            // of this handler's normal ready-state logic.
            ShowFatalError(L"fatal-error-test: deliberate ShowFatalError() probe");
            PostQuitMessage(1);
            return;
        }
        if (g_debugHeadless && g_debugDpiTest) {
            RECT suggested = { 111, 222, 111 + 900, 222 + 700 }; // distinctive, off-screen-safe
            SendMessageW(g_hwnd, WM_DPICHANGED, MAKEWPARAM(192, 192), (LPARAM)&suggested);
            RECT actual;
            GetWindowRect(g_hwnd, &actual);
            wchar_t buf[160];
            swprintf(buf, 160, L"dpi-test: suggested=(%ld,%ld,%ld,%ld) actual=(%ld,%ld,%ld,%ld)",
                suggested.left, suggested.top, suggested.right, suggested.bottom,
                actual.left, actual.top, actual.right, actual.bottom);
            AppendLog(buf);
        }
        if (g_debugHeadless && g_debugMinMaxTest) {
            MINMAXINFO mmi = {};
            SendMessageW(g_hwnd, WM_GETMINMAXINFO, 0, (LPARAM)&mmi);
            UINT dpi = GetDpiForWindow(g_hwnd);
            LONG expectedX = MulDiv(420, dpi, 96);
            LONG expectedY = MulDiv(320, dpi, 96);
            wchar_t buf[160];
            swprintf(buf, 160, L"minmax-test: dpi=%u minTrack=(%ld,%ld) expected=(%ld,%ld)",
                dpi, mmi.ptMinTrackSize.x, mmi.ptMinTrackSize.y, expectedX, expectedY);
            AppendLog(buf);
        }
        if (g_debugHeadless && g_debugSaveTest && g_haveDoc) {
            SaveDocumentTo(g_docPath, g_docUtf8 + "\n\nSaved by --mdv-save-test.\n");
            AppendLog(L"save-test: SaveDocumentTo() called directly");
        }
        if (g_debugHeadless && g_debugExportTest && g_haveDoc) {
            std::wstring target = g_docPath + L".export-test.html";
            WriteHtmlExport(target, "<!doctype html><title>export-test</title><p>Exported by --mdv-export-test.</p>");
            AppendLog(L"export-test: WriteHtmlExport() called directly, target=" + target);
        }
        if (g_debugHeadless && g_debugPdfTest && g_haveDoc) {
            std::wstring target = g_docPath + L".pdf-test.pdf";
            WritePdfExport(target);
            AppendLog(L"pdf-test: WritePdfExport() called directly, target=" + target);
        }
#endif
        if (g_controller) g_controller->put_ZoomFactor(g_zoom);
        if (g_haveDoc) SendDocMsg(g_pendingNav);
        else SendNoDoc();
#ifdef MDV_DEBUG
        if (g_debugHeadless && g_debugReopenAfterMs >= 0 && g_haveDoc) {
            SetTimer(g_hwnd, TIMER_DEBUG_REOPEN, (UINT)std::max(0, g_debugReopenAfterMs), nullptr);
            AppendLog(L"reopen armed for +" + std::to_wstring(g_debugReopenAfterMs) + L"ms");
        }
        // With no document there is nothing to render, so the JS side's
        // renderComplete signal — the usual trigger for the screenshot/exit-timer
        // sequence below — never arrives. Without this, a headless run against a
        // missing/unopenable file (or none at all) just hangs forever instead of
        // honoring --mdv-exit-after.
        if (g_debugHeadless && !g_haveDoc) {
            if (!g_debugScreenshotPath.empty()) CaptureDebugScreenshot();
            else if (g_debugExitAfterMs >= 0)
                SetTimer(g_hwnd, TIMER_DEBUG_EXIT, (UINT)std::max(0, g_debugExitAfterMs), nullptr);
        }
#endif
        if (g_warnUnsavedLossOnReady) {
            // Posting a toast right after Navigate() would race the new page's
            // own message listener; wait for it to announce it's actually ready.
            g_warnUnsavedLossOnReady = false;
            SendToast(L"The document view crashed and had to reload. Unsaved changes were lost.");
        }
    } else if (type == L"saveSettings") {
        std::wstring data;
        if (JsonGetString(json, L"data", data)) {
            std::string bytes = Narrow(data);
            if (!WriteAds(g_exePath + kAdsSettings, bytes)) {
                static bool warned = false;
                if (!warned) {
                    warned = true;
                    SendToast(L"Preferences can't be saved here (non-NTFS or read-only location). They will apply for this session only.");
                }
            }
        }
    } else if (type == L"chrome") {
        std::wstring dark;
        JsonGetString(json, L"dark", dark);
        g_dark = dark == L"1";
        ApplyChrome();
#ifdef MDV_DEBUG
        if (g_debugHeadless) {
            // ApplyChrome() -> DwmSetWindowAttribute() has fired on every
            // single run of this whole suite (applyPrefs() posts this
            // message unconditionally at page load), but nothing has ever
            // read the attribute back to confirm the call actually landed
            // rather than silently failing (wrong attribute id, an
            // unsupported OS build, an ignored HRESULT).
            BOOL actual = FALSE;
            HRESULT hr = DwmGetWindowAttribute(g_hwnd, 20 /*DWMWA_USE_IMMERSIVE_DARK_MODE*/,
                &actual, sizeof(actual));
            wchar_t buf[128];
            swprintf(buf, 128, L"chrome-message: dark=%d hr=0x%08lx actual=%d", g_dark ? 1 : 0,
                (unsigned long)hr, actual ? 1 : 0);
            AppendLog(buf);
        }
#endif
    } else if (type == L"title") {
        std::wstring text;
        if (JsonGetString(json, L"text", text)) {
            SetWindowTextW(g_hwnd, (text + L" — " + kAppTitle).c_str());
#ifdef MDV_DEBUG
            if (g_debugHeadless) AppendLog(L"title-message: text=\"" + text + L"\"");
#endif
        }
    } else if (type == L"openExternal") {
        std::wstring url;
        if (JsonGetString(json, L"url", url)) OpenExternal(url);
    } else if (type == L"openPath") {
        std::wstring path, nav;
        if (!JsonGetString(json, L"path", path)) return;
        if (!JsonGetString(json, L"nav", nav)) nav = L"link";
        // Block network/device paths: probing a UNC target authenticates to it.
        // This is deliberately scoped to openPath (paths that trace back to a
        // link the *document's own content* pointed at, via decorate()'s
        // data-open attribute) rather than pushed into OpenDocument() itself —
        // OpenDocument() is also reached from the user directly choosing a
        // path (File > Open, drag-and-drop from Explorer), where a network
        // location the user explicitly picked is legitimate and should work.
        // Canonicalize before checking: Windows treats '/' and '\' as
        // interchangeable path separators, so a raw-string check for a
        // leading "\\\\" alone (the previous version of this guard) missed
        // the equally-valid "//host/share" spelling entirely.
        wchar_t fullPath[4096];
        DWORD fullLen = GetFullPathNameW(path.c_str(), 4096, fullPath, nullptr);
        if (!fullLen || fullLen >= 4096 || !IsLocalDrivePath(fullPath)) {
            SendToast(L"Links to network locations are blocked for your security.");
            return;
        }
        path = fullPath;
        DWORD attrs = GetFileAttributesW(path.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
            PostJson(L"{\"type\":\"openFailed\",\"path\":\"" + JsonEscape(path) + L"\"}");
            SendToast(L"File not found: " + path);
            return;
        }
        if (IsMarkdownExt(ExtOf(path)) || ExtOf(path) == L"txt" || ExtOf(path) == L"text" || ExtOf(path) == L"log") {
            if (!OpenDocument(path, nav))
                PostJson(L"{\"type\":\"openFailed\",\"path\":\"" + JsonEscape(path) + L"\"}");
        } else {
            OpenLocalNonMarkdown(path);
        }
    } else if (type == L"saveDoc" || type == L"saveAsDoc") {
        std::wstring text;
        if (!JsonGetString(json, L"text", text)) return;
        std::string utf8 = Narrow(text);
        if (g_haveDoc) {
            // An untitled document has nowhere to go yet, so Save means Save As.
            bool ok = (type == L"saveAsDoc" || g_docPath.empty())
                ? SaveDocumentAs(utf8)
                : SaveDocumentTo(g_docPath, utf8);
            if (g_closeAfterSave) {
                g_closeAfterSave = false;
                // g_dirty is now clear, so the close prompt won't fire again.
                if (ok) PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
            }
        }
    } else if (type == L"exportHtml") {
        std::wstring html;
        if (!JsonGetString(json, L"html", html)) return;
        if (g_haveDoc) ExportHtml(Narrow(html));
    } else if (type == L"exportPdf") {
        if (g_haveDoc) ExportPdf();
    } else if (type == L"saveClipboardImage") {
        // A pasted screenshot (as opposed to a dropped file) has no path at
        // all — it's raw pixel data — so there's nothing to reference; it
        // has to be written to a new file next to the document first. Only
        // a small fixed set of extensions app.js can actually send (derived
        // from the clipboard item's own MIME type, not arbitrary input).
        std::wstring b64, ext;
        JsonGetString(json, L"data", b64);
        JsonGetString(json, L"ext", ext);
        static const wchar_t* kAllowedExts[] = { L"png", L"jpg", L"jpeg", L"gif", L"webp", L"bmp" };
        bool extOk = false;
        for (auto e : kAllowedExts) if (ext == e) { extOk = true; break; }
        if (!g_haveDoc || g_docDir.empty() || !extOk) {
            SendToast(L"Could not save the pasted image.");
            return;
        }
        std::string bytes;
        if (!Base64Decode(Narrow(b64), bytes) || bytes.empty()) {
            SendToast(L"Could not save the pasted image.");
            return;
        }
        std::wstring name, full;
        for (int i = 1; i <= 1000; i++) {
            name = L"pasted-image-" + std::to_wstring(i) + L"." + ext;
            full = g_docDir + L"\\" + name;
            if (GetFileAttributesW(full.c_str()) == INVALID_FILE_ATTRIBUTES) break;
            name.clear();
        }
        HANDLE h = name.empty() ? INVALID_HANDLE_VALUE :
            CreateFileW(full.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h == INVALID_HANDLE_VALUE) {
            SendToast(L"Could not save the pasted image.");
            return;
        }
        DWORD written = 0;
        bool ok = WriteFile(h, bytes.data(), (DWORD)bytes.size(), &written, nullptr) && written == bytes.size();
        CloseHandle(h);
        if (!ok) {
            DeleteFileW(full.c_str());
            SendToast(L"Could not save the pasted image.");
            return;
        }
        // Same message a dropped image uses, but with created:true — unlike
        // a drop (which only references a file that already existed), this
        // just wrote one to disk. "Nothing is ever written without you
        // asking" (README) still holds in spirit — the user did just paste
        // an image — but silently is not the same promise as visibly, so
        // the page shows this one instead of only announcing it.
        PostJson(L"{\"type\":\"insertImage\",\"path\":\"" + JsonEscape(name) + L"\",\"created\":true}");
    } else if (type == L"newDoc") {
        g_watcher.Stop();
        g_docUtf8.clear();
        g_docToken++;
        g_docPath.clear();
        g_docDir.clear();
        g_docName = L"Untitled";
        g_docPlain = false;
        g_docCrlf = false;   // new files get plain LF endings
        g_docBom = false;
        g_docEncoding = mdv::TextEncoding::Utf8;
        g_docSize = 0;
        g_docModifiedMs = 0;
        g_haveDoc = true;
        g_dirty = false;
        g_editing = false;
        UpdateTitle();
        SendDocMsg(L"new");
    } else if (type == L"editing") {
        std::wstring on;
        JsonGetString(json, L"on", on);
        g_editing = on == L"1";
#ifdef MDV_DEBUG
        if (g_debugHeadless) AppendLog(L"editing-message: on=" + on);
#endif
    } else if (type == L"dirty") {
        std::wstring on;
        JsonGetString(json, L"on", on);
        bool was = g_dirty;
        g_dirty = on == L"1";
        if (was != g_dirty) UpdateTitle();
#ifdef MDV_DEBUG
        if (g_debugHeadless) {
            wchar_t titleBuf[300];
            GetWindowTextW(g_hwnd, titleBuf, 300);
            AppendLog(L"dirty-message: on=" + on + L" title=\"" + titleBuf + L"\"");
        }
#endif
    } else if (type == L"debugLog") {
        // Forwarded from the page only when window.__MDV_BOOT.debug is true
        // (a debug build launched with --mdv-headless) — console.*, window
        // error events, and the progressive-render timing/settle signal.
        std::wstring level, text;
        JsonGetString(json, L"level", level);
        JsonGetString(json, L"text", text);
        AppendLog(L"[js:" + level + L"] " + text);
#ifdef MDV_DEBUG
        if (level == L"renderComplete") {
            g_debugRenderStats = text;
            DebugPhaseMark(L"render-complete");
            if (g_debugHeadless && g_debugMinimizeTest) {
                // Deliberately AFTER the render, not at "ready" -- minimizing
                // earlier would throttle the very timers the progressive
                // renderer's own pacing depends on (Page Visibility API),
                // turning this into a test of throttling recovery instead of
                // the WM_SIZE geometry transition it's actually meant to
                // verify. By this point content is already fully rendered,
                // so a brief minimize/restore cycle can't perturb it.
                ShowWindow(g_hwnd, SW_MINIMIZE);
                SetTimer(g_hwnd, TIMER_DEBUG_RESTORE, 300, nullptr);
            }
            // With --mdv-repeat the benchmark runs *after* this first render, and
            // --mdv-editor-test's self-test likewise, so exiting now would cut
            // either off and throw away the run's actual result; benchComplete /
            // editorTestComplete below own the exit in those cases instead.
            if (g_debugRepeat <= 1 && !g_debugEditorTest) {
                // CapturePreview is asynchronous and its duration scales with
                // how much there is to composite — starting the exit timer
                // unconditionally alongside it (rather than from its completion
                // callback) raced the two for any document big enough that
                // capture took longer than --mdv-exit-after, closing the
                // process before the PNG was actually written. Chain them.
                if (!g_debugScreenshotPath.empty()) CaptureDebugScreenshot();
                else if (g_debugExitAfterMs >= 0)
                    SetTimer(g_hwnd, TIMER_DEBUG_EXIT, (UINT)std::max(0, g_debugExitAfterMs), nullptr);
            }
        } else if (level == L"benchComplete" || level == L"editorTestComplete") {
            // --mdv-repeat's aggregate result, or --mdv-editor-test's pass/fail
            // summary — either way, the run's actual payload.
            g_debugRenderStats = text;
            DebugPhaseMark(level == L"benchComplete" ? L"bench-complete" : L"editor-test-complete");
            if (!g_debugScreenshotPath.empty()) CaptureDebugScreenshot();
            else if (g_debugExitAfterMs >= 0)
                SetTimer(g_hwnd, TIMER_DEBUG_EXIT, (UINT)std::max(0, g_debugExitAfterMs), nullptr);
        }
#endif
    } else if (type == L"openDialog") {
        ShowOpenDialog();
    } else if (type == L"revealDoc") {
        if (g_haveDoc) RevealInExplorer(g_docPath);
    } else if (type == L"zoom") {
        std::wstring dir;
        JsonGetString(json, L"dir", dir);
        if (dir == L"in") SetZoom(g_zoom * 1.1);
        else if (dir == L"out") SetZoom(g_zoom / 1.1);
        else SetZoom(1.0);
    } else if (type == L"fullscreen") {
        ToggleFullscreen();
    } else if (type == L"reload") {
        ReloadDoc();
    }
}

// ---------------------------------------------------------------- accelerator keys

static bool IsKeyDown(int vk) { return (GetKeyState(vk) & 0x8000) != 0; }

static bool HandleAccelerator(UINT vk) {
    bool ctrl = IsKeyDown(VK_CONTROL);
    bool shift = IsKeyDown(VK_SHIFT);
    bool alt = IsKeyDown(VK_MENU);

    if (ctrl && !alt) {
        switch (vk) {
        case 'O': SendCmd(L"openRequest"); return true;   // the page guards unsaved edits
        case 'F': SendCmd(L"find"); return true;
        case 'G': SendCmd(shift ? L"findPrev" : L"findNext"); return true;
        case 'B':
            // While editing, Ctrl+B means bold — let it through to the page.
            if (g_editing) return false;
            SendCmd(L"toc");
            return true;
        case 'W': PostMessageW(g_hwnd, WM_CLOSE, 0, 0); return true;
        case 'R': SendCmd(L"reloadRequest"); return true;   // the page guards unsaved edits
        case 'S': SendCmd(shift ? L"saveAs" : L"save"); return true;
        case 'E': SendCmd(L"toggleEdit"); return true;
        case 'N': SendCmd(L"newDoc"); return true;
        case VK_OEM_COMMA: SendCmd(L"a11y"); return true;
        case VK_OEM_PLUS: case VK_ADD: SetZoom(g_zoom * 1.1); return true;
        case VK_OEM_MINUS: case VK_SUBTRACT: SetZoom(g_zoom / 1.1); return true;
        case '0': case VK_NUMPAD0: SetZoom(1.0); return true;
        // Browser accelerators that make no sense in a document viewer:
        case 'J': case 'L': case 'T': case 'U': case 'D': case 'H':
            return true;
        }
        return false;
    }
    if (alt && !ctrl) {
        if (vk == VK_LEFT) { SendCmd(L"back"); return true; }
        if (vk == VK_RIGHT) { SendCmd(L"forward"); return true; }
        return false;
    }
    if (!ctrl && !alt) {
        switch (vk) {
        case VK_F1: SendCmd(L"help"); return true;
        case VK_F3: SendCmd(shift ? L"findPrev" : L"findNext"); return true;
        case VK_F5: SendCmd(L"reloadRequest"); return true;   // the page guards unsaved edits
        case VK_F11: ToggleFullscreen(); return true;
        }
    }
    return false;
}

// Shut down for real. Split out of WM_CLOSE so the unsaved-changes prompt can
// defer it until a save finishes.
static void FinishClose() {
#ifdef MDV_DEBUG
    if (g_debugHeadless) {
        // Disarm first, before anything below gets a chance to run long and
        // let the watchdog fire mid-shutdown — which would misreport a clean
        // run that was merely slow as a hang, the opposite of what it's for.
        KillTimer(g_hwnd, TIMER_DEBUG_WATCHDOG);
        DebugPhaseMark(L"shutdown");
        AppendLog(L"clean shutdown");
        WriteDebugProfile();
    }
#endif
    SaveWindowAds();
#ifdef MDV_DEBUG
    // Deleting the profile on the way out would defeat the very thing this
    // experiment is measuring (whether a warm profile speeds the next launch).
    if (g_debugPersistProfile) { DestroyWindow(g_hwnd); return; }
#endif
    if (g_webview) {
        ComPtr<ICoreWebView2_13> wv13;
        if (SUCCEEDED(g_webview.As(wv13))) {
            ComPtr<ICoreWebView2Profile> profile;
            if (SUCCEEDED(wv13->get_Profile(profile.Put()))) {
                ComPtr<ICoreWebView2Profile8> p8;
                if (SUCCEEDED(profile.As(p8)))
                    p8->Delete();
            }
        }
    }
    DestroyWindow(g_hwnd);
}

// ---------------------------------------------------------------- webview setup

static std::wstring BuildBootScript() {
    std::wstring settings = L"null";
    if (!g_settingsBlob.empty()) {
        std::wstring blob = Widen(g_settingsBlob.data(), (int)g_settingsBlob.size());
        settings = L"\"" + JsonEscape(blob) + L"\"";
    }
    std::wstring s = L"window.__MDV_BOOT={settings:";
    s += settings;
    s += L",version:\"";
    s += kVersion;
    s += L"\",dark:";
    s += g_dark ? L"true" : L"false";
    s += L",zoom:";
    s += std::to_wstring((int)(g_zoom * 100 + 0.5));
    // Both reflect state already settled by this point: g_solo is decided at
    // the very top of startup (the named-mutex check), and any cliDoc is
    // opened synchronously before CreateWebView()'s async controller-creation
    // callback (which is what eventually runs BuildBootScript) ever gets a
    // chance to fire on the message loop. Lets the page decide for itself
    // whether a session-restore attempt is safe, without needing to parse the
    // settings blob natively (main.cpp treats that JSON as opaque).
    s += L",solo:";
    s += g_solo ? L"true" : L"false";
    s += L",hasDoc:";
    s += g_haveDoc ? L"true" : L"false";
    s += L",debug:";
#ifdef MDV_DEBUG
    s += g_debugHeadless ? L"true" : L"false";
    s += L",repeat:";
    s += std::to_wstring(g_debugRepeat);
    s += L",frameBudget:";
    s += std::to_wstring(g_debugFrameBudget);
    s += L",editorTest:";
    s += g_debugEditorTest ? L"true" : L"false";
    s += L",rejectionTest:";
    s += g_debugRejectionTest ? L"true" : L"false";
    s += L",selfTokenTest:";
    s += g_debugSelfTokenTest ? L"true" : L"false";
    s += L",travDir:\"";
    s += JsonEscape(g_debugTravDir);
    s += L"\"";
#else
    s += L"false";
    s += L",repeat:1,frameBudget:0,editorTest:false,rejectionTest:false,selfTokenTest:false,travDir:\"\"";
#endif
    s += L"};";
    return s;
}

static void ConfigureWebView() {
    ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(g_webview->get_Settings(settings.Put()))) {
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_AreDevToolsEnabled(FALSE);
        settings->put_AreDefaultScriptDialogsEnabled(TRUE);
        settings->put_IsBuiltInErrorPageEnabled(FALSE);
        settings->put_AreHostObjectsAllowed(FALSE);
        settings->put_IsZoomControlEnabled(TRUE);
    }

    EventRegistrationToken tok;

    g_webview->add_WebMessageReceived(
        MakeCB<ICoreWebView2WebMessageReceivedEventHandler,
               ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs*>(
            [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                LPWSTR json = nullptr;
                if (SUCCEEDED(args->get_WebMessageAsJson(&json)) && json) {
                    HandleWebMessage(json);
                    CoTaskMemFree(json);
                }
                return S_OK;
            }), &tok);

    g_webview->AddWebResourceRequestedFilter(L"https://app.local/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    g_webview->AddWebResourceRequestedFilter(L"https://doc.local/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    g_webview->add_WebResourceRequested(
        MakeCB<ICoreWebView2WebResourceRequestedEventHandler,
               ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs*>(
            [](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                HandleWebResource(args);
                return S_OK;
            }), &tok);

    g_webview->add_NavigationStarting(
        MakeCB<ICoreWebView2NavigationStartingEventHandler,
               ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*>(
            [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                LPWSTR uriRaw = nullptr;
                if (SUCCEEDED(args->get_Uri(&uriRaw)) && uriRaw) {
                    std::wstring uri = uriRaw;
                    CoTaskMemFree(uriRaw);
                    if (!StartsWith(uri, kAppOrigin))
                        args->put_Cancel(TRUE);
                }
                return S_OK;
            }), &tok);

    g_webview->add_NewWindowRequested(
        MakeCB<ICoreWebView2NewWindowRequestedEventHandler,
               ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs*>(
            [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                args->put_Handled(TRUE);
                LPWSTR uriRaw = nullptr;
                if (SUCCEEDED(args->get_Uri(&uriRaw)) && uriRaw) {
                    std::wstring uri = uriRaw;
                    CoTaskMemFree(uriRaw);
                    if (StartsWith(uri, L"http://") || StartsWith(uri, L"https://"))
                        if (!StartsWith(uri, kAppOrigin) && !StartsWith(uri, kDocOrigin))
                            OpenExternal(uri);
                }
                return S_OK;
            }), &tok);

    g_webview->add_ProcessFailed(
        MakeCB<ICoreWebView2ProcessFailedEventHandler,
               ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*>(
            [](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
                // A child process (renderer, GPU, a utility process) died —
                // this handler running at all means the *host* process
                // (this one) survived it. Worth a durable record regardless:
                // this is the other place, besides a genuine crash in our
                // own code, that a document view can go blank out from
                // under the reader.
                COREWEBVIEW2_PROCESS_FAILED_KIND kind = COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED;
                if (args) args->get_ProcessFailedKind(&kind);
                bool wasDirty = g_dirty;
                wchar_t buf[220];
                swprintf(buf, 220, L"WebView2 ProcessFailed kind=%d doc=%s dirty=%d", (int)kind,
                    g_haveDoc ? g_docPath.c_str() : L"(none)", wasDirty ? 1 : 0);
                AppendLog(buf);
                // The crashed process took any in-progress, unsaved edit with it —
                // that's gone whether or not we navigate away. Resync our state to
                // match the fresh page the reload is about to produce, and tell the
                // reader once it's back up rather than let the title bar's dirty
                // bullet just quietly vanish (see the "ready" handler for the toast).
                g_dirty = false;
                g_editing = false;
                UpdateTitle();
                if (wasDirty) g_warnUnsavedLossOnReady = true;
                if (g_webview) g_webview->Navigate(L"https://app.local/index.html");
                return S_OK;
            }), &tok);

    // Trim the context menu to viewer-appropriate entries.
    ComPtr<ICoreWebView2_11> wv11;
    if (SUCCEEDED(g_webview.As(wv11))) {
        wv11->add_ContextMenuRequested(
            MakeCB<ICoreWebView2ContextMenuRequestedEventHandler,
                   ICoreWebView2*, ICoreWebView2ContextMenuRequestedEventArgs*>(
                [](ICoreWebView2*, ICoreWebView2ContextMenuRequestedEventArgs* args) -> HRESULT {
                    ComPtr<ICoreWebView2ContextMenuItemCollection> items;
                    if (FAILED(args->get_MenuItems(items.Put())) || !items) return S_OK;
                    static const wchar_t* keep[] = {
                        L"copy", L"selectAll", L"copyLinkLocation", L"copyLinkText",
                        L"copyImage", L"copyImageLocation",
                    };
                    UINT32 count = 0;
                    items->get_Count(&count);
                    for (INT32 i = (INT32)count - 1; i >= 0; i--) {
                        ComPtr<ICoreWebView2ContextMenuItem> item;
                        if (FAILED(items->GetValueAtIndex(i, item.Put())) || !item) continue;
                        LPWSTR nameRaw = nullptr;
                        bool keepIt = false;
                        if (SUCCEEDED(item->get_Name(&nameRaw)) && nameRaw) {
                            for (auto k : keep)
                                if (_wcsicmp(nameRaw, k) == 0) { keepIt = true; break; }
                            CoTaskMemFree(nameRaw);
                        }
                        if (!keepIt) items->RemoveValueAtIndex(i);
                    }
                    return S_OK;
                }), &tok);
    }

    g_controller->add_AcceleratorKeyPressed(
        MakeCB<ICoreWebView2AcceleratorKeyPressedEventHandler,
               ICoreWebView2Controller*, ICoreWebView2AcceleratorKeyPressedEventArgs*>(
            [](ICoreWebView2Controller*, ICoreWebView2AcceleratorKeyPressedEventArgs* args) -> HRESULT {
                COREWEBVIEW2_KEY_EVENT_KIND kind;
                if (FAILED(args->get_KeyEventKind(&kind))) return S_OK;
                if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN &&
                    kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) return S_OK;
                UINT vk = 0;
                if (FAILED(args->get_VirtualKey(&vk))) return S_OK;
                if (HandleAccelerator(vk)) args->put_Handled(TRUE);
                return S_OK;
            }), &tok);

    g_controller->add_ZoomFactorChanged(
        MakeCB<ICoreWebView2ZoomFactorChangedEventHandler,
               ICoreWebView2Controller*, IUnknown*>(
            [](ICoreWebView2Controller* sender, IUnknown*) -> HRESULT {
                double z = 1.0;
                // Also fires for WebView2's own built-in Ctrl+MouseWheel zoom
                // (still enabled — see IsZoomControlEnabled below), not just
                // SetZoom()'s keyboard accelerators. Without posting here too,
                // wheel-zoom silently updated g_zoom with no on-screen toast.
                if (SUCCEEDED(sender->get_ZoomFactor(&z)) && (z > g_zoom + 0.001 || z < g_zoom - 0.001)) {
                    g_zoom = z;
                    PostJson(L"{\"type\":\"zoom\",\"v\":\"" + std::to_wstring((int)(g_zoom * 100 + 0.5)) + L"\"}");
                }
                return S_OK;
            }), &tok);

    ApplyChrome();

    // Inject boot data, then navigate.
    std::wstring boot = BuildBootScript();
    g_webview->AddScriptToExecuteOnDocumentCreated(boot.c_str(),
        MakeCB<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler,
               HRESULT, LPCWSTR>(
            [](HRESULT, LPCWSTR) -> HRESULT {
                AppendLog(L"navigating");
#ifdef MDV_DEBUG
                DebugPhaseMark(L"navigating");
#endif
                g_webview->Navigate(L"https://app.local/index.html");
                return S_OK;
            }));
}

static void CreateWebView() {
    HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, g_udfPath.c_str(), nullptr,
        MakeCB<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler,
               HRESULT, ICoreWebView2Environment*>(
            [](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                if (FAILED(result) || !env) {
                    wchar_t buf[128];
                    swprintf(buf, 128, L"Could not start the WebView2 rendering engine. (hr=0x%08X)", (unsigned)result);
                    ShowFatalError(buf);
                    PostQuitMessage(1);
                    return S_OK;
                }
                AppendLog(L"environment created");
#ifdef MDV_DEBUG
                DebugPhaseMark(L"environment-created");
#endif
                env->AddRef();
                g_env.Attach(env);

                auto controllerDone =
                    MakeCB<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,
                           HRESULT, ICoreWebView2Controller*>(
                        [](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                            if (FAILED(result) || !controller) {
                                wchar_t buf[128];
                                swprintf(buf, 128, L"Could not create the WebView2 view. (hr=0x%08X)", (unsigned)result);
                                ShowFatalError(buf);
                                PostQuitMessage(1);
                                return S_OK;
                            }
                            AppendLog(L"controller created");
#ifdef MDV_DEBUG
                            DebugPhaseMark(L"controller-created");
#endif
                            controller->AddRef();
                            g_controller.Attach(controller);
                            g_controller->get_CoreWebView2(g_webview.Put());
                            RECT rc;
                            GetClientRect(g_hwnd, &rc);
                            g_controller->put_Bounds(rc);
                            g_controller->put_ZoomFactor(g_zoom);
                            ConfigureWebView();
                            return S_OK;
                        });

                // Prefer an in-private (non-persisting) profile when supported.
                ComPtr<ICoreWebView2Environment10> env10;
                ComPtr<ICoreWebView2Environment> envRef;
                envRef.Attach(env);
                env->AddRef();
                bool created = false;
                if (SUCCEEDED(envRef.As(env10))) {
                    ComPtr<ICoreWebView2ControllerOptions> opts;
                    if (SUCCEEDED(env10->CreateCoreWebView2ControllerOptions(opts.Put()))) {
                        opts->put_ProfileName(L"MDView");
                        // InPrivate and a reused profile directory are mutually
                        // exclusive — the pair fails outright with 0x8007012F on
                        // the second launch — so the experiment turns both knobs
                        // together or neither.
                        BOOL inPrivate = TRUE;
#ifdef MDV_DEBUG
                        if (g_debugPersistProfile) inPrivate = FALSE;
#endif
                        opts->put_IsInPrivateModeEnabled(inPrivate);
                        if (SUCCEEDED(env10->CreateCoreWebView2ControllerWithOptions(g_hwnd, opts.Get(), controllerDone))) {
                            created = true;
                        }
                    }
                }
                if (!created)
                    g_env->CreateCoreWebView2Controller(g_hwnd, controllerDone);
                return S_OK;
            }));
    if (FAILED(hr)) {
        ShowFatalError(
            L"The WebView2 runtime is not available.\n\n"
            L"It ships with Windows 11 and updates through Microsoft Edge. "
            L"You can reinstall it from:\nhttps://developer.microsoft.com/microsoft-edge/webview2/");
        PostQuitMessage(1);
    }
}

// ---------------------------------------------------------------- window proc

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_SIZE:
        if (g_controller) {
            if (wp == SIZE_MINIMIZED) {
                g_controller->put_IsVisible(FALSE);
#ifdef MDV_DEBUG
                if (g_debugHeadless && g_debugMinimizeTest)
                    AppendLog(L"minimize-test: WM_SIZE(SIZE_MINIMIZED), controller hidden");
#endif
            } else {
                g_controller->put_IsVisible(TRUE);
                RECT rc;
                GetClientRect(hwnd, &rc);
                g_controller->put_Bounds(rc);
#ifdef MDV_DEBUG
                if (g_debugHeadless && g_debugMinimizeTest)
                    AppendLog(L"minimize-test: WM_SIZE(restored), controller visible, bounds set");
#endif
            }
        }
        return 0;
    case WM_MOVE:
        if (g_controller) g_controller->NotifyParentWindowPositionChanged();
        return 0;
    case WM_DPICHANGED: {
        RECT* r = (RECT*)lp;
        SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top,
            SWP_NOZORDER | SWP_NOACTIVATE);
        return 0;
    }
    case WM_SETFOCUS:
        if (g_controller) g_controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        return 0;
    case WM_GETMINMAXINFO: {
        MINMAXINFO* mmi = (MINMAXINFO*)lp;
        UINT dpi = GetDpiForWindow(hwnd);
        mmi->ptMinTrackSize.x = MulDiv(420, dpi, 96);
        mmi->ptMinTrackSize.y = MulDiv(320, dpi, 96);
        return 0;
    }
    case WM_ERASEBKGND: {
        HDC dc = (HDC)wp;
        RECT rc;
        GetClientRect(hwnd, &rc);
        FillRect(dc, &rc, g_dark ? g_brushDark : g_brushLight);
        return 1;
    }
    case WM_DROPFILES: {
        HDROP drop = (HDROP)wp;
        wchar_t path[4096];
        if (DragQueryFileW(drop, 0, path, 4096)) {
            std::wstring ext = ExtOf(path);
            static const wchar_t* kImageExts[] = { L"png", L"jpg", L"jpeg", L"gif", L"webp", L"bmp", L"svg" };
            bool isImage = false;
            for (auto e : kImageExts) if (ext == e) { isImage = true; break; }
            if (g_editing && isImage && g_haveDoc) {
                // Dropping an image while editing inserts a reference to it
                // instead of trying to open it as the document (which would
                // just fail — LooksBinary() rejects it). Prefer a path
                // relative to the document's own folder over an absolute
                // one: it's what a markdown author would normally write, and
                // stays correct if the document and image are moved together.
                std::wstring full = path, rel;
                std::wstring prefix = g_docDir + L"\\";
                if (full.size() > prefix.size() && _wcsnicmp(full.c_str(), prefix.c_str(), prefix.size()) == 0)
                    rel = full.substr(prefix.size());
                else
                    rel = full;
                std::replace(rel.begin(), rel.end(), L'\\', L'/');
                PostJson(L"{\"type\":\"insertImage\",\"path\":\"" + JsonEscape(rel) + L"\"}");
            } else {
                bool go = true;
                if (g_dirty) {
#ifdef MDV_DEBUG
                    if (g_debugHeadless) {
                        AppendLog(L"drop-files: discarding unsaved changes (headless, no prompt)");
                    } else
#endif
                    go = MessageBoxW(hwnd,
                        (L"You have unsaved changes to " + g_docName +
                         L".\n\nOpening another file will discard them. Continue?").c_str(),
                        kAppTitle, MB_OKCANCEL | MB_ICONWARNING) == IDOK;
                }
                if (go) OpenDocument(path, L"new");   // reports its own failure reason
            }
        }
        DragFinish(drop);
        return 0;
    }
    case WM_APP_WATCH:
        // Ignore the change notification caused by our own save.
        if (GetTickCount64() < g_suppressWatchUntil) return 0;
#ifdef MDV_DEBUG
        if (g_debugHeadless && g_debugDirtyOnWatch) {
            g_dirty = true;
            AppendLog(L"dirty-on-watch: g_dirty set true inside WM_APP_WATCH (simulating an edit landing exactly when the change notification arrives)");
        }
        if (g_debugHeadless && g_debugModalTest) {
            g_modalDepth++;
            AppendLog(L"modal-test: g_modalDepth incremented inside WM_APP_WATCH (simulating a real dialog already open when the change notification arrives)");
            SetTimer(hwnd, TIMER_DEBUG_MODAL_CLOSE, 500, nullptr);
        }
#endif
        SetTimer(hwnd, TIMER_RELOAD, 150, nullptr);
        return 0;
    case WM_TIMER:
        if (wp == TIMER_RELOAD) {
            KillTimer(hwnd, TIMER_RELOAD);
            TryAutoReload();
        }
#ifdef MDV_DEBUG
        else if (wp == TIMER_DEBUG_EXIT) {
            KillTimer(hwnd, TIMER_DEBUG_EXIT);
            AppendLog(L"--mdv-exit-after elapsed, closing");
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        } else if (wp == TIMER_DEBUG_WATCHDOG) {
            KillTimer(hwnd, TIMER_DEBUG_WATCHDOG);
            g_debugOutcome = L"watchdog-timeout";
            // Read the last real phase *before* stamping the watchdog's own,
            // or the diagnostic just reports the watchdog finding itself.
            std::wstring stalledAfter = g_debugPhases.empty() ? L"(none)" : g_debugPhases.back().name;
            DebugPhaseMark(L"watchdog-fired");
            wchar_t buf[260];
            swprintf(buf, 260,
                L"WATCHDOG: %dms elapsed without a clean finish. stalledAfter=%s webReady=%d haveDoc=%d",
                g_debugTimeoutMs, stalledAfter.c_str(), g_webReady ? 1 : 0, g_haveDoc ? 1 : 0);
            AppendLog(buf);
            WriteDebugProfile();
            // Deliberately not WM_CLOSE: whatever wedged this run may also be
            // wedging an orderly shutdown, and the entire point of a watchdog
            // is that it cannot itself hang. Leave immediately.
            ExitProcess(2);
        } else if (wp == TIMER_DEBUG_REOPEN) {
            KillTimer(hwnd, TIMER_DEBUG_REOPEN);
            AppendLog(L"reopen firing: OpenDocument(" + g_docPath + L") while previous render likely still in flight");
            DebugPhaseMark(L"reopen-fired");
            OpenDocument(g_docPath, L"new");
        } else if (wp == TIMER_DEBUG_RESTORE) {
            KillTimer(hwnd, TIMER_DEBUG_RESTORE);
            ShowWindow(hwnd, SW_RESTORE);
        } else if (wp == TIMER_DEBUG_MODAL_CLOSE) {
            KillTimer(hwnd, TIMER_DEBUG_MODAL_CLOSE);
            g_modalDepth--;
            AppendLog(L"modal-test: g_modalDepth decremented (simulating the dialog closing)");
        }
#endif
        return 0;
    case WM_CLOSE:
        // A save-then-close round trip is already in flight (the page hasn't
        // answered the earlier "saveDoc" yet) — a second close request here
        // (double-clicking X, Ctrl+W again) would show a redundant prompt
        // whose own answer could race the first one, e.g. "No, discard" on
        // the second prompt closing the window out from under the first
        // save still in progress. Ignore it; the in-flight save will finish
        // the close itself once it succeeds, or leave the window open with
        // g_dirty still set (so a fresh close request re-prompts normally)
        // if it fails.
        if (g_closeAfterSave) return 0;
        if (g_dirty && g_haveDoc) {
#ifdef MDV_DEBUG
            if (g_debugHeadless) {
                AppendLog(L"WM_CLOSE: discarding unsaved changes (headless, no prompt)");
                g_dirty = false;
            } else {
#endif
            int r = MessageBoxW(hwnd,
                (L"Save changes to " + g_docName + L"?").c_str(),
                kAppTitle, MB_YESNOCANCEL | MB_ICONWARNING);
            if (r == IDCANCEL) return 0;
            if (r == IDYES) {
                g_closeAfterSave = true;
                SendCmd(L"saveThenClose");   // the page owns the text; it will call back
                return 0;
            }
            g_dirty = false;   // discard
#ifdef MDV_DEBUG
            }
#endif
        }
        FinishClose();
        return 0;
    case WM_DESTROY:
        g_watcher.Stop();
        if (g_controller) g_controller->Close();
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

// ---------------------------------------------------------------- startup

// ---------------------------------------------------------------- diagnostics

static std::wstring DefaultLogPath() {
    wchar_t tmp[MAX_PATH];
    GetTempPathW(MAX_PATH, tmp);
    return std::wstring(tmp) + L"MDView-crash.log";
}

// One open handle for AppendLog's whole process lifetime -- see its own
// comment for why. INVALID_HANDLE_VALUE until the first routine log line.
static HANDLE g_logHandle = INVALID_HANDLE_VALUE;

static std::wstring TimestampPrefix() {
    SYSTEMTIME st; GetLocalTime(&st);
    wchar_t stamp[64];
    swprintf(stamp, 64, L"[%02d:%02d:%02d.%03d +%8.1fms] ",
        st.wHour, st.wMinute, st.wSecond, st.wMilliseconds, ElapsedMs());
    return stamp;
}

// A long-lived install accumulates this log forever otherwise -- every
// launch appends at least 5 routine lines (instance/solo, profile sweep,
// environment created, navigating, controller created) and nothing has ever
// capped or rotated it. Checked only when (re)opening g_logHandle, i.e. at
// most once per process, not per line: past 2MB, the existing file becomes
// <path>.old (discarding at most one prior generation) and a fresh one
// starts. Byte-identical line format either side of a rotation -- this only
// changes when a NEW file starts, never what gets written to it.
static void RotateLogIfNeeded(const std::wstring& path) {
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &fad)) return;
    ULONGLONG size = ((ULONGLONG)fad.nFileSizeHigh << 32) | fad.nFileSizeLow;
    if (size <= 2ull * 1024 * 1024) return;
    std::wstring old = path + L".old";
    DeleteFileW(old.c_str());
    MoveFileW(path.c_str(), old.c_str());
}

// Routine, high-frequency logging (phase marks, per-message diagnostics in a
// debug build): reuses one handle for the process's whole lifetime and does
// NOT flush on every call -- unlike the old implementation, which opened,
// wrote, flushed, and closed a fresh handle for every single line, a real
// cost paid 5+ times on every ordinary launch, debug or release. The OS's
// own write-behind still lands these on disk within seconds regardless;
// CloseLog() (called once, at clean shutdown) flushes explicitly so a normal
// exit's trailing lines are durable without paying that cost on the way
// there. The durability this gives up is only routine lines from a crash
// that ALSO isn't one of the specific paths AppendLogFatal below covers
// (SEH exceptions, std::terminate, ShowFatalError) -- AppendLogFatal is what
// actually matters for real crash diagnosis, and it flushes every time.
static void AppendLog(const std::wstring& line) {
    if (g_logHandle == INVALID_HANDLE_VALUE) {
        std::wstring path = g_logPath.empty() ? DefaultLogPath() : g_logPath;
        RotateLogIfNeeded(path);
        g_logHandle = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (g_logHandle == INVALID_HANDLE_VALUE) return;
        SetFilePointer(g_logHandle, 0, nullptr, FILE_END);
    }
    std::string utf8 = Narrow(TimestampPrefix() + line + L"\r\n");
    DWORD written = 0;
    WriteFile(g_logHandle, utf8.data(), (DWORD)utf8.size(), &written, nullptr);
}

// Flushes and closes the routine log handle. Called once, at clean shutdown.
static void CloseLog() {
    if (g_logHandle == INVALID_HANDLE_VALUE) return;
    FlushFileBuffers(g_logHandle);
    CloseHandle(g_logHandle);
    g_logHandle = INVALID_HANDLE_VALUE;
}

// Fatal-path logging ONLY (CrashHandler, TerminateHandler, ShowFatalError):
// a fully self-contained open+write+flush+close, deliberately independent of
// g_logHandle's state -- the process may not survive the next instruction,
// so this line's durability can't depend on some later CloseLog() ever
// running. This is exactly AppendLog's old unconditional behavior, kept
// as-is for the three call sites that actually need it.
static void AppendLogFatal(const std::wstring& line) {
    std::wstring path = g_logPath.empty() ? DefaultLogPath() : g_logPath;
    HANDLE h = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    SetFilePointer(h, 0, nullptr, FILE_END);
    std::string utf8 = Narrow(TimestampPrefix() + line + L"\r\n");
    DWORD written = 0;
    WriteFile(h, utf8.data(), (DWORD)utf8.size(), &written, nullptr);
    FlushFileBuffers(h);
    CloseHandle(h);
}

// Caught regardless of build type: a plain Win32 exception (access
// violation, stack overflow, etc.) anywhere in this process, including
// inside a WebView2 SDK callback running on our thread. Logs what we knew at
// the moment it happened, then lets the process terminate as it normally
// would — this does not attempt recovery, only forensics.
static LONG WINAPI CrashHandler(EXCEPTION_POINTERS* ep) {
    DWORD code = (ep && ep->ExceptionRecord) ? ep->ExceptionRecord->ExceptionCode : 0;
    void* addr = (ep && ep->ExceptionRecord) ? ep->ExceptionRecord->ExceptionAddress : nullptr;
    // ASLR randomizes the module's load address every run, so a raw `addr`
    // is only useful with a matching PDB loaded in a debugger session that
    // happens to share this exact run's base -- neither is available from a
    // user's crash report. The module base + the address as an RVA (offset
    // from that base) is stable across runs and directly resolvable against
    // any build's .pdb via `!addr`/`ln` in windbg, with no live process
    // needed. Zero cost to compute; the crash log's own comment used to note
    // this address was effectively unusable without both, which this fixes.
    HMODULE base = GetModuleHandleW(nullptr);
    unsigned long long rva = (base && addr) ? (uintptr_t)addr - (uintptr_t)base : 0;
    wchar_t buf[600];
    swprintf(buf, 600,
        L"UNHANDLED EXCEPTION code=0x%08X addr=%p base=%p rva=0x%llX doc=%s dirty=%d editing=%d webReady=%d haveController=%d",
        code, addr, (void*)base, rva, g_haveDoc ? g_docPath.c_str() : L"(none)", g_dirty ? 1 : 0, g_editing ? 1 : 0,
        g_webReady ? 1 : 0, g_controller ? 1 : 0);
    AppendLogFatal(buf);
    return EXCEPTION_EXECUTE_HANDLER;
}

// Complements CrashHandler(): an uncaught C++ exception reaches
// std::terminate() via a different path than a Win32 SEH exception (MSVC's
// default terminate handler calls abort(), which does not reliably route
// through SetUnhandledExceptionFilter), so it needs its own hook to be logged.
static void TerminateHandler() {
    AppendLogFatal(L"UNCAUGHT C++ EXCEPTION reached std::terminate()");
    std::abort();
}

// Every one of this app's few fatal-error MessageBoxW calls goes through
// here. A modal dialog blocks forever in a headless/scripted run — nothing
// will ever click it — which turns "the app hit an error" into "the app
// hangs indefinitely", exactly the failure this diagnostic infrastructure
// exists to catch rather than reproduce. Always logged, either way.
static void ShowFatalError(const wchar_t* msg) {
    AppendLogFatal(std::wstring(L"FATAL: ") + msg);
#ifdef MDV_DEBUG
    if (g_debugHeadless) return;
#endif
    MessageBoxW(g_hwnd, msg, kAppTitle, MB_ICONERROR);
}

#ifdef MDV_DEBUG
// CapturePreview's completion handler takes a single HRESULT — the only
// one-argument callback interface this app needs, so it gets its own small
// wrapper rather than a variant of the generic two-argument Callback<> used
// for every WebView2 completion handler with two.
class CapturePreviewDoneHandler final : public ICoreWebView2CapturePreviewCompletedHandler {
    std::function<HRESULT(HRESULT)> fn_;
    LONG ref_ = 1;
public:
    explicit CapturePreviewDoneHandler(std::function<HRESULT(HRESULT)> fn) : fn_(std::move(fn)) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == __uuidof(ICoreWebView2CapturePreviewCompletedHandler) || riid == __uuidof(IUnknown)) {
            *ppv = static_cast<ICoreWebView2CapturePreviewCompletedHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&ref_); }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG r = InterlockedDecrement(&ref_);
        if (!r) delete this;
        return r;
    }
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode) override { return fn_(errorCode); }
};

// Saves a PNG of the current page to --mdv-screenshot, entirely off-screen
// (the window need not be visible for WebView2 to composite it — see the
// off-screen window placement in wWinMain when --mdv-headless is set).
// Starts the --mdv-exit-after countdown, once whatever needed to happen
// first (here, always: a screenshot attempt, successful or not) actually has.
static void ArmDebugExitTimer() {
    // Only ever called after a screenshot attempt (see CaptureDebugScreenshot,
    // itself only reachable from a --mdv-headless run) -- so an unset
    // --mdv-exit-after must still terminate the process now that its one job
    // (the screenshot) is done, rather than silently hanging until the
    // watchdog eventually force-kills it. std::max(0, -1) == 0: an unset
    // exit-after now means "exit immediately", not "never".
    SetTimer(g_hwnd, TIMER_DEBUG_EXIT, (UINT)std::max(0, g_debugExitAfterMs), nullptr);
}

// A headless run must always terminate. Anything can stall — the WebView2
// engine, a renderer process, the page's own JS — and an automated run that
// hangs instead of failing costs far more than one that reports a timeout:
// it wedges whatever is driving it until someone notices and kills it by
// hand. This watchdog guarantees an exit and, more usefully, a log and a
// profile recording exactly which phase was never reached.
static void ArmDebugWatchdog() {
    if (g_debugHeadless && g_debugTimeoutMs > 0)
        SetTimer(g_hwnd, TIMER_DEBUG_WATCHDOG, (UINT)g_debugTimeoutMs, nullptr);
}

// Machine-readable counterpart to the log: one JSON object per run, so a
// before/after comparison is a diff of numbers rather than a reading exercise.
static void WriteDebugProfile() {
    if (!g_debugHeadless || g_debugProfilePath.empty()) return;

    PROCESS_MEMORY_COUNTERS pmc{};
    pmc.cb = sizeof(pmc);
    GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc));

    std::wstring j = L"{\n  \"outcome\": \"";
    j += g_debugOutcome;
    j += L"\",\n  \"doc\": \"" + JsonEscape(g_haveDoc ? g_docPath : L"(none)") + L"\",\n";
    wchar_t num[128];
    swprintf(num, 128, L"  \"totalMs\": %.1f,\n", ElapsedMs());
    j += num;
    swprintf(num, 128, L"  \"peakWorkingSetKB\": %llu,\n",
        (unsigned long long)(pmc.PeakWorkingSetSize / 1024));
    j += num;
    j += L"  \"renderStats\": \"" + JsonEscape(g_debugRenderStats) + L"\",\n";
    j += L"  \"phases\": [\n";
    for (size_t i = 0; i < g_debugPhases.size(); i++) {
        swprintf(num, 128, L"    { \"name\": \"%s\", \"atMs\": %.1f }",
            g_debugPhases[i].name.c_str(), g_debugPhases[i].atMs);
        j += num;
        if (i + 1 < g_debugPhases.size()) j += L",";
        j += L"\n";
    }
    j += L"  ]\n}\n";

    HANDLE h = CreateFileW(g_debugProfilePath.c_str(), GENERIC_WRITE, FILE_SHARE_READ,
        nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) { AppendLog(L"profile: could not create output file"); return; }
    std::string utf8 = Narrow(j);
    DWORD written = 0;
    WriteFile(h, utf8.data(), (DWORD)utf8.size(), &written, nullptr);
    FlushFileBuffers(h);
    CloseHandle(h);
    AppendLog(L"profile: written to " + g_debugProfilePath);
}

static void CaptureDebugScreenshot() {
    if (!g_webview) { AppendLog(L"screenshot: no webview"); ArmDebugExitTimer(); return; }
    IStream* raw = nullptr;
    HRESULT hr = SHCreateStreamOnFileW(g_debugScreenshotPath.c_str(), STGM_CREATE | STGM_WRITE, &raw);
    if (FAILED(hr) || !raw) { AppendLog(L"screenshot: could not create output file"); ArmDebugExitTimer(); return; }
    ComPtr<IStream> stream;
    stream.Attach(raw);
    hr = g_webview->CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, stream.Get(),
        new CapturePreviewDoneHandler([](HRESULT hr) -> HRESULT {
            AppendLog(SUCCEEDED(hr) ? L"screenshot: saved" : L"screenshot: capture failed");
            ArmDebugExitTimer();
            return S_OK;
        }));
    if (FAILED(hr)) {
        // Failed synchronously, before the operation was even queued — the
        // completion handler above will never fire, so nothing else will arm
        // the exit timer. Without this a headless run just hangs forever.
        AppendLog(L"screenshot: CapturePreview failed to start");
        ArmDebugExitTimer();
    }
}
#endif

// Instrumented unconditionally (not behind g_debugHeadless): this is on the
// REAL release-build startup path every ordinary user hits, and the whole
// point is to measure that real cost, not just a debug-flag-gated
// simulation of it. Every prior measurement of this app's startup time
// (tools/regression.ps1, tools/profile-run.ps1) has wiped this same
// directory before every single launch, so every number ever recorded
// measured the empty-directory case -- the cost this logs has never once
// been separated from "controller creation," long assumed fixed and
// environment-level, in this project's own history. See the profile-dir
// scenario's sibling investigation (docs/BACKLOG.md, "the startup
// measurement") for the three-arm experiment this log line exists to run.
static void SweepTempProfile() {
#ifdef MDV_DEBUG
    if (g_debugPersistProfile) { AppendLog(L"profile sweep skipped (--mdv-persist-profile)"); return; }
#endif
    if (!g_solo) { AppendLog(L"profile sweep skipped (not solo)"); return; }
    double t0 = ElapsedMs();
    std::error_code ec;
    bool existed = std::filesystem::exists(g_udfPath, ec);
    // A just-closed previous instance's WebView2 browser subprocess can take a
    // moment to fully release the profile directory even after this app's own
    // process has already exited — child-process teardown is asynchronous and
    // outlives the host process. A relaunch that races this can leave the
    // directory partially swept; WebView2 treats that as a corrupt profile and
    // either fails to open outright or falls back to a multi-second repair
    // path. Retry briefly rather than risk either — this only ever adds delay
    // on that narrow race; the common case (nothing left, or a clean delete on
    // the first try) is unaffected.
    int attempt = 0;
    for (; attempt < 10; attempt++) {
        std::filesystem::remove_all(g_udfPath, ec);
        if (!std::filesystem::exists(g_udfPath, ec)) break;
        Sleep(100);
    }
    // Gave up after ~1s if the loop ran out; proceed with whatever's left,
    // as before (best effort).
    wchar_t buf[220];
    swprintf(buf, 220, L"profile sweep: existed=%d attempts=%d ms=%.1f",
        existed ? 1 : 0, attempt + 1, ElapsedMs() - t0);
    AppendLog(buf);
#ifdef MDV_DEBUG
    DebugPhaseMark(L"profile-swept");
#endif
}

int WINAPI wWinMain(HINSTANCE hinst, HINSTANCE, LPWSTR, int nCmdShow) {
    QueryPerformanceFrequency(&g_qpcFreq);
    QueryPerformanceCounter(&g_qpcStart);
    g_hinst = hinst;
    SetUnhandledExceptionFilter(CrashHandler);
    std::set_terminate(TerminateHandler);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    wchar_t exe[4096];
    GetModuleFileNameW(nullptr, exe, 4096);
    g_exePath = exe;

    // command line document, plus (debug builds only) scripted-testing flags.
    // This must run BEFORE the mutex/g_solo/SweepTempProfile block below:
    // SweepTempProfile() reads g_debugPersistProfile, and both it and the new
    // "instance:" log line below depend on g_logPath being set from
    // --mdv-log= first -- previously this whole block ran before argument
    // parsing, so --mdv-persist-profile was silently non-functional (always
    // saw g_debugPersistProfile == false) and any log line written here went
    // to DefaultLogPath() instead of the requested --mdv-log= path.
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::wstring cliDoc;
    for (int i = 1; i < argc; i++) {
        std::wstring a = argv[i];
#ifdef MDV_DEBUG
        if (a == L"--mdv-headless") { g_debugHeadless = true; continue; }
        if (StartsWith(a, L"--mdv-log=")) { g_logPath = a.substr(10); continue; }
        if (StartsWith(a, L"--mdv-screenshot=")) { g_debugScreenshotPath = a.substr(17); continue; }
        if (StartsWith(a, L"--mdv-exit-after=")) { g_debugExitAfterMs = _wtoi(a.substr(17).c_str()); continue; }
        if (StartsWith(a, L"--mdv-profile=")) { g_debugProfilePath = a.substr(14); continue; }
        if (StartsWith(a, L"--mdv-timeout=")) { g_debugTimeoutMs = _wtoi(a.substr(14).c_str()); continue; }
        if (StartsWith(a, L"--mdv-repeat=")) { g_debugRepeat = std::max(1, _wtoi(a.substr(13).c_str())); continue; }
        if (StartsWith(a, L"--mdv-reopen-after=")) { g_debugReopenAfterMs = _wtoi(a.substr(19).c_str()); continue; }
        if (a == L"--mdv-persist-profile") { g_debugPersistProfile = true; continue; }
        if (StartsWith(a, L"--mdv-frame-budget=")) { g_debugFrameBudget = _wtoi(a.substr(19).c_str()); continue; }
        if (StartsWith(a, L"--mdv-crash-test=")) { g_debugCrashTest = a.substr(17); continue; }
        if (a == L"--mdv-fatal-error-test") { g_debugFatalErrorTest = true; continue; }
        if (a == L"--mdv-dpi-test") { g_debugDpiTest = true; continue; }
        if (a == L"--mdv-save-test") { g_debugSaveTest = true; continue; }
        if (a == L"--mdv-export-test") { g_debugExportTest = true; continue; }
        if (a == L"--mdv-pdf-test") { g_debugPdfTest = true; continue; }
        if (StartsWith(a, L"--mdv-trav-dir=")) { g_debugTravDir = a.substr(15); continue; }
        if (a == L"--mdv-rejection-test") { g_debugRejectionTest = true; continue; }
        if (a == L"--mdv-self-token-test") { g_debugSelfTokenTest = true; continue; }
        if (a == L"--mdv-minimize-test") { g_debugMinimizeTest = true; continue; }
        if (a == L"--mdv-minmax-test") { g_debugMinMaxTest = true; continue; }
        if (a == L"--mdv-dirty-on-watch") { g_debugDirtyOnWatch = true; continue; }
        if (a == L"--mdv-modal-test") { g_debugModalTest = true; continue; }
        if (StartsWith(a, L"--mdv-watch-fail=")) { g_debugWatchFail = a.substr(17); continue; }
        if (StartsWith(a, L"--mdv-profile-dir=")) { g_debugProfileDirOverride = a.substr(18); continue; }
        if (a == L"--mdv-editor-test") { g_debugEditorTest = true; continue; }
#endif
        if (cliDoc.empty()) cliDoc = a;
    }
    if (argv) LocalFree(argv);
#ifdef MDV_DEBUG
    // The first phase mark used to be "launch" (below, after LoadWindowAds/
    // LoadSettingsBlob and SweepTempProfile() have already run) -- meaning
    // the sweep's own cost was invisible in every phase timeline this
    // project has ever recorded. This one sits before it, as an honest
    // process-start anchor (its atMs is still measured from the real
    // QueryPerformanceCounter baseline at the top of wWinMain regardless of
    // exactly where in the function it's called).
    DebugPhaseMark(L"process-start");
#endif

    g_instanceMutex = CreateMutexW(nullptr, FALSE, kInstanceMutexName);
    g_solo = GetLastError() != ERROR_ALREADY_EXISTS;
    // g_solo gates SweepTempProfile() below (a second instance must never
    // delete the shared WebView2 profile a first, already-running instance
    // may still be using) -- previously invisible in any log, so this
    // safety mechanism had never actually been exercised by a test.
    AppendLog(g_solo ? L"instance: solo (first/only)" : L"instance: not solo (another instance already running)");

    wchar_t tmp[MAX_PATH];
    GetTempPathW(MAX_PATH, tmp);
    g_udfPath = std::wstring(tmp) + kProfileDirName;
#ifdef MDV_DEBUG
    if (!g_debugProfileDirOverride.empty()) g_udfPath = g_debugProfileDirOverride;
#endif
    SweepTempProfile();

    LoadWindowAds();
    LoadSettingsBlob();
#ifdef MDV_DEBUG
    if (g_debugHeadless) {
        wchar_t hdr[320];
        swprintf(hdr, 320, L"--- launch (headless) repeat=%d timeout=%dms doc=%s",
            g_debugRepeat, g_debugTimeoutMs, cliDoc.empty() ? L"(none)" : cliDoc.c_str());
        AppendLog(hdr);
        DebugPhaseMark(L"launch");
    }
#endif

    g_brushLight = CreateSolidBrush(RGB(0xff, 0xff, 0xff));
    g_brushDark = CreateSolidBrush(RGB(0x15, 0x18, 0x1c));

    WNDCLASSEXW wc = { sizeof(wc) };
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hinst;
    wc.hIcon = LoadIconW(hinst, MAKEINTRESOURCEW(IDI_APP));
    wc.hIconSm = wc.hIcon;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.lpszClassName = kWndClass;
    RegisterClassExW(&wc);

    int x = CW_USEDEFAULT, y = CW_USEDEFAULT, w, h;
    UINT dpi = GetDpiForSystem();
    w = MulDiv(1080, dpi, 96);
    h = MulDiv(820, dpi, 96);
    RECT work;
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    w = std::min<int>(w, work.right - work.left - 40);
    h = std::min<int>(h, work.bottom - work.top - 40);
    if (g_havePlacement) {
        x = g_savedRect.left;
        y = g_savedRect.top;
        w = g_savedRect.right - g_savedRect.left;
        h = g_savedRect.bottom - g_savedRect.top;
    }

    {
        wchar_t buf[160];
        swprintf(buf, 160, L"window rect x=%d y=%d w=%d h=%d havePlacement=%d", x, y, w, h, (int)g_havePlacement);
        AppendLog(buf);
    }
    DWORD winExStyle = 0;
#ifdef MDV_DEBUG
    // Off-screen rather than SW_HIDE/minimized: a hidden or minimized window
    // can make the page's Visibility API report hidden, which throttles
    // timers and animation frames — exactly the scheduling the progressive
    // renderer's pacing depends on. Off-screen keeps the page "visible" as
    // far as the engine is concerned while never appearing on the real
    // display; WS_EX_TOOLWINDOW keeps it out of the taskbar and Alt+Tab.
    if (g_debugHeadless) { winExStyle = WS_EX_TOOLWINDOW; x = -32000; y = -32000; }
#endif
    g_hwnd = CreateWindowExW(winExStyle, kWndClass, kAppTitle, WS_OVERLAPPEDWINDOW,
        x, y, w, h, nullptr, nullptr, hinst, nullptr);
    if (!g_hwnd) return 1;

    DragAcceptFiles(g_hwnd, TRUE);
    ApplyChrome();
#ifdef MDV_DEBUG
    ShowWindow(g_hwnd, g_debugHeadless ? SW_SHOWNOACTIVATE : (g_savedMax ? SW_SHOWMAXIMIZED : nCmdShow));
#else
    ShowWindow(g_hwnd, g_savedMax ? SW_SHOWMAXIMIZED : nCmdShow);
#endif
    UpdateWindow(g_hwnd);
#ifdef MDV_DEBUG
    ArmDebugWatchdog();   // from here on, this run is guaranteed to terminate
#endif

    // Kick off WebView2 environment/controller creation immediately — it is
    // fully asynchronous from this call (the 'ready' handshake in
    // ConfigureWebView() already tolerates the document finishing its own
    // load either before or after that handshake arrives), so the engine
    // spins up in the background while the file below is read on this
    // thread, instead of only starting once that read — which can be slow
    // on a network path — has already finished.
    CreateWebView();

    if (!cliDoc.empty()) {
        if (!OpenDocument(cliDoc, L"new")) {
#ifdef MDV_DEBUG
            if (g_debugHeadless) AppendLog(L"could not open: " + cliDoc);
            else
#endif
            MessageBoxW(g_hwnd, (L"Could not open:\n" + cliDoc).c_str(), kAppTitle, MB_ICONWARNING);
        }
    }
    UpdateTitle();

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    g_watcher.Stop();
    // g_env/g_controller/g_webview are namespace-scope ComPtrs; left alone,
    // their Release() calls would run during CRT static destruction, i.e.
    // after CoUninitialize() below tears down this thread's COM apartment --
    // releasing a COM interface with no apartment initialized is undefined
    // behavior. Reset them explicitly, in reverse dependency order, while
    // the apartment is still live.
    g_webview.Reset();
    g_controller.Reset();
    g_env.Reset();
    if (g_instanceMutex) CloseHandle(g_instanceMutex);
    CoUninitialize();
    CloseLog();   // flush + close the routine-log handle AppendLog kept open
    return (int)msg.wParam;
}
