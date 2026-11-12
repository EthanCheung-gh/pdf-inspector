#!/bin/bash
#
# PDF Inspector - Debian/Ubuntu post-install script.
#
# electron-builder's `deb.afterInstall` REPLACES its generated
# templates/linux/after-install.tpl, so the update-alternatives /
# chrome-sandbox / desktop-database logic of that template is reproduced here
# verbatim; the only addition is the launcher split at the end.
#
# Why the split: the install prefix contains a space ("/opt/PDF Inspector") and
# Chromium's zygote helper cannot execvp such a path, so a sandboxed launch dies
# with `LaunchProcess: failed to execvp: /opt/PDF` followed by
# `FATAL:zygote_host_impl_linux.cc(201) Check failed: Invalid argument (22)`.
# `linux.executableArgs` puts --no-sandbox into freshly generated .desktop
# entries, but a desktop environment (GNOME Shell) may keep serving a cached
# entry from an earlier install without the flag. Turning the launcher path into
# a tiny wrapper that always appends --no-sandbox keeps even those stale Exec
# lines working, while the real Electron binary stays untouched as
# `pdf-inspector-bin`.
#
# electron-builder expands its executable / sanitized-product-name macros in
# this file at build time (see electron-builder.yml), which is how the literal
# paths below are produced. Keep those two macros and do not introduce other
# brace-expanded macros; the generated postinst never sees them.
#
# The script must be idempotent: it runs on install, upgrade and reinstall.

LAUNCHER_PATH='/opt/${sanitizedProductName}/${executable}'
BIN_PATH='/opt/${sanitizedProductName}/${executable}-bin'

fail() {
    echo "pdf-inspector postinst: $*" >&2
    exit 1
}

is_elf() {
    # 7f 45 4c 46 == \x7fELF: a real (Electron) executable, not our shell shim.
    head -c 4 -- "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n' | grep -qx '7f454c46'
}

is_wrapper() {
    # Our shim is a shell script that execs pdf-inspector-bin.
    head -c 2 -- "$1" 2>/dev/null | grep -q '#!' &&
        head -c 4096 -- "$1" 2>/dev/null | grep -q 'pdf-inspector-bin'
}

# --- electron-builder default post-install behaviour -------------------------

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# SUID chrome-sandbox for Electron 5+
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# --- launcher split: real binary + --no-sandbox wrapper ----------------------

if [ ! -d '/opt/${sanitizedProductName}' ]; then
    fail "installation directory /opt/${sanitizedProductName} is missing"
fi

if [ -L "${LAUNCHER_PATH}" ]; then
    # Truncating through a symlink could destroy pdf-inspector-bin, so drop the
    # link and recreate the wrapper below.
    rm -f "${LAUNCHER_PATH}" || fail "could not remove symlink ${LAUNCHER_PATH}"
fi

if [ -e "${LAUNCHER_PATH}" ] && is_elf "${LAUNCHER_PATH}"; then
    # Fresh install, or upgrade over a build that shipped the raw Electron
    # binary at the launcher path: move it aside (mv preserves its mode) and put
    # the wrapper in its place.
    echo "pdf-inspector postinst: moving Electron binary to ${BIN_PATH}" >&2
    mv -f "${LAUNCHER_PATH}" "${BIN_PATH}" ||
        fail "could not move ${LAUNCHER_PATH} to ${BIN_PATH}"
elif [ -e "${LAUNCHER_PATH}" ] && is_wrapper "${LAUNCHER_PATH}"; then
    # Upgrade/reinstall of an already-wrapped install: keep the existing wrapper
    # (never overwrite it, never recurse into it), but the binary must be there.
    if [ ! -e "${BIN_PATH}" ]; then
        fail "${BIN_PATH} is missing although ${LAUNCHER_PATH} is already the wrapper; reinstall the package"
    fi
    is_elf "${BIN_PATH}" ||
        fail "${BIN_PATH} is not an executable binary; reinstall the package"
    echo "pdf-inspector postinst: launcher wrapper already in place" >&2
elif [ ! -e "${LAUNCHER_PATH}" ]; then
    if [ ! -e "${BIN_PATH}" ]; then
        fail "neither ${LAUNCHER_PATH} nor ${BIN_PATH} exists; reinstall the package"
    fi
    is_elf "${BIN_PATH}" ||
        fail "${BIN_PATH} is not an executable binary; reinstall the package"
    echo "pdf-inspector postinst: recreating missing launcher wrapper" >&2
else
    fail "${LAUNCHER_PATH} is neither the Electron binary nor the PDF Inspector wrapper"
fi

if ! is_wrapper "${LAUNCHER_PATH}"; then
    cat > "${LAUNCHER_PATH}" <<'PDF_INSPECTOR_WRAPPER_EOF'
#!/bin/sh
# Generated by the PDF Inspector Debian post-install script; do not edit.
#
# The real Electron binary lives next to this script as pdf-inspector-bin.
# --no-sandbox is forced here because Chromium's zygote helper cannot execvp the
# install path "/opt/PDF Inspector" (space in the directory name) and would
# otherwise abort with "failed to execvp: /opt/PDF" plus a
# zygote_host_impl_linux.cc FATAL. Forcing it in the wrapper means launchers
# with a cached .desktop entry (Exec without the flag) still start.
exec "/opt/${sanitizedProductName}/${executable}-bin" --no-sandbox "$@"
PDF_INSPECTOR_WRAPPER_EOF
    chmod 755 "${LAUNCHER_PATH}" || fail "could not chmod 755 ${LAUNCHER_PATH}"
    echo "pdf-inspector postinst: installed launcher wrapper at ${LAUNCHER_PATH}" >&2
fi

exit 0
