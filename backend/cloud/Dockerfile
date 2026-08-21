FROM golang:1.24-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
ENV CGO_ENABLED=0
# -trimpath keeps build-machine paths out of the binary; the tests run in
# CI/locally, not here, so this stage only builds.
RUN go build -trimpath -o /out/api ./cmd/api

FROM alpine:3.20
WORKDIR /app
# tzdata is required, not optional, for this product: every "today" is
# resolved in the business's own IANA timezone (see
# domain.Business.Today), and a scratch/alpine image without the zone
# database silently falls back to UTC — which would roll a 6am milk round
# over to the next day at the wrong moment. A missing package here would
# be a subtle wrong-day bug, not a crash, so it is installed deliberately.
RUN apk add --no-cache tzdata
COPY --from=build /out/api /app/api
EXPOSE 8080
ENTRYPOINT ["/app/api"]
