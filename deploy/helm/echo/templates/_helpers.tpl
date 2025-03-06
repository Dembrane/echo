{{- define "echo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "echo.fullname" -}}
{{- printf "%s-%s" (include "echo.name" .) .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
