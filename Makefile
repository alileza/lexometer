.PHONY: build web test run

build: web
	go build -o claudewatch .

web:
	npx -y esbuild web/src/app.ts --bundle --minify --outfile=web/dist/app.js

test:
	go test ./...

run: build
	./claudewatch
