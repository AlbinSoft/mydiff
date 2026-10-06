#!/usr/bin/env bash
# Actualiza MyDiff a la ultima version de la rama main de GitHub.
# Sobrescribe los ficheros del repo; connections.data.php y auth_config.php
# no estan en el repo, asi que nunca se tocan.
#
# Uso: ./update.sh   (desde cualquier directorio)

# Todo va dentro de main() y se ejecuta en la ultima linea: bash lee el script
# por trozos y este fichero se sobrescribe durante la actualizacion.

main() {
    set -euo pipefail

    local repo_url="https://github.com/AlbinSoft/mydiff/archive/refs/heads/main.tar.gz"
    local app_dir
    app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    if [ ! -f "$app_dir/api.php" ]; then
        echo "Error: no se encuentra api.php en $app_dir. Esto no parece una instalacion de MyDiff." >&2
        exit 1
    fi

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    trap 'rm -rf "$tmp_dir"' EXIT

    echo "Descargando la ultima version..."
    curl -fsSL "$repo_url" | tar -xz -C "$tmp_dir"

    # El tar trae una unica carpeta raiz (mydiff-main)
    local src_dir
    src_dir="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    if [ -z "$src_dir" ] || [ ! -f "$src_dir/api.php" ]; then
        echo "Error: la descarga no contiene una version valida de MyDiff." >&2
        exit 1
    fi

    echo "Copiando ficheros en $app_dir..."
    cp -a "$src_dir/." "$app_dir/"
    chmod +x "$app_dir/update.sh"

    echo "MyDiff actualizado correctamente."
    exit 0
}

main "$@"
