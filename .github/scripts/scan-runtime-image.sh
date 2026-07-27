#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 6 ]]; then
  echo "usage: $0 IMAGE RUNTIME COMPONENT_NAME COMPONENT_VERSION OUTPUT_DIRECTORY EXPECTED_BUNDLE_INPUT" >&2
  exit 2
fi

readonly image_ref=$1
readonly runtime_kind=$2
readonly component_name=$3
readonly component_version=$4
readonly requested_output_directory=$5
readonly requested_expected_bundle_input=$6
readonly syft_image='docker.io/anchore/syft@sha256:b4f1df79f97b817682d8b5ff941eb6bfe74f6172553a5e312c75bbc2eabc405c'
readonly grype_image='docker.io/anchore/grype@sha256:fd4ab4d1042b522c896e73bdf09ab8bf384fa417df99d6dd0d6e1008c7e7c821'
policy_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
readonly policy_directory
readonly bundle_input_verifier="${policy_directory}/verify-runtime-bundle-input.mjs"
test -f "$bundle_input_verifier"
test -r "$bundle_input_verifier"
scanner_uid=$(id -u)
scanner_gid=$(id -g)
readonly scanner_uid
readonly scanner_gid
readonly scanner_user="${scanner_uid}:${scanner_gid}"

if ((scanner_uid == 0)); then
  echo "runtime image scans must be launched by an unprivileged host user" >&2
  exit 2
fi

case "$runtime_kind" in
  repo|indexer|api|safe-app-backend) ;;
  *)
    echo "unsupported runtime kind: $runtime_kind" >&2
    exit 2
    ;;
esac

mkdir -p "$requested_output_directory"
output_directory=$(cd "$requested_output_directory" && pwd -P)
scan_directory=$(mktemp -d "${output_directory}/.runtime-scan.XXXXXX")
container_id=

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$scan_directory"
}
trap cleanup EXIT

readonly image_sbom="${output_directory}/sbom-${runtime_kind}.spdx.json"
readonly bundle_sbom="${output_directory}/bundle-input-${runtime_kind}.cdx.json"
readonly expected_bundle_sbom="${output_directory}/expected-bundle-input-${runtime_kind}.cdx.json"
readonly image_report="${output_directory}/grype-image-${runtime_kind}.json"
readonly bundle_report="${output_directory}/grype-bundle-input-${runtime_kind}.json"
readonly summary="${output_directory}/scan-summary-${runtime_kind}.json"

printf 'check-for-app-update: false\n' > "${scan_directory}/syft-config.yaml"
printf 'check-for-app-update: false\n' > "${scan_directory}/grype-update-config.yaml"
printf 'check-for-app-update: false\ndb:\n  auto-update: false\n  validate-by-hash-on-start: true\n  validate-age: true\n' \
  > "${scan_directory}/grype-scan-config.yaml"
mkdir "${scan_directory}/syft-cache"
docker image save "$image_ref" --output "${scan_directory}/image.tar"

# The scanner receives only a read-only image archive and has no Docker socket
# or network access. Its executable is selected by an exact OCI index digest.
docker run --rm \
  --user "$scanner_user" \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 64 \
  --tmpfs "/tmp:rw,noexec,nosuid,size=1g,uid=${scanner_uid},gid=${scanner_gid},mode=1770" \
  --volume "${scan_directory}/syft-cache:/.cache/syft" \
  --volume "${scan_directory}:/scan:ro" \
  "$syft_image" \
  --config /scan/syft-config.yaml \
  "docker-archive:/scan/image.tar" \
  --output spdx-json > "$image_sbom"

jq -e '
  .spdxVersion == "SPDX-2.3" and
  any(.creationInfo.creators[]; . == "Tool: syft-1.48.0") and
  ([.packages[] |
    select(
      .name == "node" and
      .versionInfo == "22.23.1" and
      any(
        .externalRefs[]?;
        .referenceCategory == "PACKAGE-MANAGER" and
        .referenceType == "purl" and
        .referenceLocator == "pkg:generic/node@22.23.1"
      )
    )
  ] | length) == 1 and
  ([.packages[] |
    select(
      any(
        .externalRefs[]?;
        .referenceCategory == "PACKAGE-MANAGER" and
        .referenceType == "purl" and
        (.referenceLocator | startswith("pkg:apk/alpine/"))
      )
    )
  ] | length) > 0
' "$image_sbom" >/dev/null

image_package_count=$(jq -er '.packages | length' "$image_sbom")
image_npm_count=$(
  jq -er '
    [.packages[] |
      select(
        any(
          .externalRefs[]?;
          .referenceCategory == "PACKAGE-MANAGER" and
          .referenceType == "purl" and
          (.referenceLocator | startswith("pkg:npm/"))
        )
      )
    ] | length
  ' "$image_sbom"
)

bundle_component_count=0
bundle_status=present
bundle_sha256=absent
if [[ "$runtime_kind" == 'safe-app-backend' ]]; then
  if [[ "$requested_expected_bundle_input" != 'absent' ]]; then
    echo "Safe backend must declare the independent NCC bundle input absent" >&2
    exit 2
  fi
  bundle_status=absent
  if ((image_npm_count == 0)); then
    echo "Safe backend image SBOM contains no installed npm packages" >&2
    exit 1
  fi
else
  if [[ "$requested_expected_bundle_input" == 'absent' ]]; then
    echo "NCC runtimes require an independently generated bundle-input SBOM" >&2
    exit 2
  fi
  if [[ ! -f "$requested_expected_bundle_input" || ! -r "$requested_expected_bundle_input" || ! -s "$requested_expected_bundle_input" ]]; then
    echo "expected bundle-input SBOM must be a readable, non-empty regular file" >&2
    exit 2
  fi
  expected_bundle_input_parent=$(
    cd "$(dirname "$requested_expected_bundle_input")" && pwd -P
  )
  readonly expected_bundle_input_parent
  expected_bundle_input_path="${expected_bundle_input_parent}/$(basename "$requested_expected_bundle_input")"
  readonly expected_bundle_input_path
  cp "$expected_bundle_input_path" "$expected_bundle_sbom"

  container_id=$(docker create "$image_ref")
  docker cp \
    "${container_id}:/usr/app/bundle-input-dependencies.cdx.json" \
    "$bundle_sbom"
  docker rm "$container_id" >/dev/null
  container_id=

  bundle_sha256=$(
    node "$bundle_input_verifier" "$expected_bundle_sbom" "$bundle_sbom"
  )
  readonly bundle_sha256

  jq -e \
    --arg component_name "$component_name" \
    --arg component_version "$component_version" \
    '
      .bomFormat == "CycloneDX" and
      .specVersion == "1.6" and
      .metadata.component.name == $component_name and
      .metadata.component.version == $component_version and
      any(
        .metadata.properties[];
        .name == "io.reya.cannon.bundle-input-selection" and
        .value == "pnpm list --prod --no-optional --depth Infinity --json"
      ) and
      (.components | length) > 0 and
      all(
        .components[];
        .type == "library" and
        (.name | type) == "string" and
        (.version | type) == "string" and
        (.purl | startswith("pkg:npm/"))
      )
    ' "$bundle_sbom" >/dev/null
  bundle_component_count=$(jq -er '.components | length' "$bundle_sbom")
fi

mkdir "${scan_directory}/grype-cache"

# Refresh and validate the database before any SBOM is mounted into the
# networked scanner container. The actual scans below run with no network.
docker run --rm \
  --user "$scanner_user" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 64 \
  --tmpfs "/tmp:rw,noexec,nosuid,size=256m,uid=${scanner_uid},gid=${scanner_gid},mode=1770" \
  --volume "${scan_directory}/grype-cache:/.cache/grype" \
  --volume "${scan_directory}:/scan:ro" \
  "$grype_image" \
  --config /scan/grype-update-config.yaml \
  db update

scan_sbom() {
  local sbom_path=$1
  local report_path=$2

  # The evidence is mounted read-only and scanned offline. The scanner root
  # filesystem is immutable; its DB cache is deleted after this invocation.
  docker run --rm \
    --user "$scanner_user" \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 64 \
    --tmpfs "/tmp:rw,noexec,nosuid,size=256m,uid=${scanner_uid},gid=${scanner_gid},mode=1770" \
    --volume "${scan_directory}/grype-cache:/.cache/grype" \
    --volume "${scan_directory}:/scan:ro" \
    --volume "${output_directory}:/evidence:ro" \
    "$grype_image" \
    --config /scan/grype-scan-config.yaml \
    "sbom:/evidence/$(basename "$sbom_path")" \
    --output json > "$report_path"
}

scan_sbom "$image_sbom" "$image_report"
if [[ "$runtime_kind" != 'safe-app-backend' ]]; then
  scan_sbom "$bundle_sbom" "$bundle_report"
fi

jq -e '
  .descriptor.version == "0.116.0" and
  .descriptor.db.status.valid == true and
  .descriptor.configuration.db["auto-update"] == false and
  .descriptor.configuration.db["validate-by-hash-on-start"] == true and
  .descriptor.configuration.db["validate-age"] == true and
  .descriptor.configuration["only-fixed"] == false and
  .descriptor.configuration["ignore-wontfix"] == "" and
  (.descriptor.configuration.exclude | length) == 0 and
  (.descriptor.configuration.ignore | length) == 4 and
  all(
    .descriptor.configuration.ignore[];
    .vulnerability == "" and
    (.package.type == "rpm" or .package.type == "deb")
  )
' "$image_report" >/dev/null
image_critical=$(jq -er '[.matches[] | select(.vulnerability.severity == "Critical")] | length' "$image_report")
image_high=$(jq -er '[.matches[] | select(.vulnerability.severity == "High")] | length' "$image_report")
database_schema=$(jq -er '.descriptor.db.status.schemaVersion' "$image_report")
database_built=$(jq -er '.descriptor.db.status.built' "$image_report")
database_source=$(jq -er '.descriptor.db.status.from' "$image_report")
bundle_critical=0
bundle_high=0
if [[ "$runtime_kind" != 'safe-app-backend' ]]; then
  jq -e \
    --arg database_built "$database_built" \
    --arg database_schema "$database_schema" \
    '
      .descriptor.version == "0.116.0" and
      .descriptor.db.status.valid == true and
      .descriptor.configuration.db["auto-update"] == false and
      .descriptor.configuration.db["validate-by-hash-on-start"] == true and
      .descriptor.configuration.db["validate-age"] == true and
      .descriptor.configuration["only-fixed"] == false and
      .descriptor.configuration["ignore-wontfix"] == "" and
      (.descriptor.configuration.exclude | length) == 0 and
      (.descriptor.configuration.ignore | length) == 4 and
      all(
        .descriptor.configuration.ignore[];
        .vulnerability == "" and
        (.package.type == "rpm" or .package.type == "deb")
      ) and
      .descriptor.db.status.built == $database_built and
      .descriptor.db.status.schemaVersion == $database_schema
    ' "$bundle_report" >/dev/null
  bundle_critical=$(jq -er '[.matches[] | select(.vulnerability.severity == "Critical")] | length' "$bundle_report")
  bundle_high=$(jq -er '[.matches[] | select(.vulnerability.severity == "High")] | length' "$bundle_report")
fi

jq -n \
  --arg bundle_input_sbom "$bundle_status" \
  --arg bundle_input_sha256 "$bundle_sha256" \
  --arg component_name "$component_name" \
  --arg component_version "$component_version" \
  --arg database_built "$database_built" \
  --arg database_schema "$database_schema" \
  --arg database_source "$database_source" \
  --arg grype_image "$grype_image" \
  --arg image_ref "$image_ref" \
  --arg runtime "$runtime_kind" \
  --arg syft_image "$syft_image" \
  --argjson bundle_component_count "$bundle_component_count" \
  --argjson bundle_critical "$bundle_critical" \
  --argjson bundle_high "$bundle_high" \
  --argjson image_critical "$image_critical" \
  --argjson image_high "$image_high" \
  --argjson image_npm_count "$image_npm_count" \
  --argjson image_package_count "$image_package_count" \
  '{
    runtime: $runtime,
    image: $image_ref,
    component: {
      name: $component_name,
      version: $component_version
    },
    scanners: {
      syft: $syft_image,
      grype: $grype_image,
      vulnerability_database: {
        schema: $database_schema,
        built: $database_built,
        source: $database_source
      }
    },
    image_sbom: {
      packages: $image_package_count,
      detected_npm_packages: $image_npm_count,
      critical: $image_critical,
      high: $image_high
    },
    bundle_input_sbom: {
      status: $bundle_input_sbom,
      source_closure_sha256: $bundle_input_sha256,
      components: $bundle_component_count,
      critical: $bundle_critical,
      high: $bundle_high,
      interpretation: "Conservative production dependency input to the NCC bundle; a match is not proof that the vulnerable code path is reachable."
    }
  }' > "$summary"

cat "$summary"

if ((image_critical + image_high + bundle_critical + bundle_high > 0)); then
  echo "HIGH or CRITICAL runtime-image findings require remediation or a reviewed, expiring exception" >&2
  exit 1
fi
