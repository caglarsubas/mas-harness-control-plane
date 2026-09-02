{{- define "planeon-control.name" -}}
{{- printf "%s-%s" .Release.Name .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "planeon-control.image" -}}
{{- $repository := required (printf "%s.image.repository is required" .component) .values.image.repository -}}
{{- $digest := required (printf "%s.image.digest is required" .component) .values.image.digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) -}}
{{- fail (printf "%s.image.digest must be sha256:<64-lowercase-hex>" .component) -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end -}}
