.PHONY: build web test run

build: web
	go build -o lexometer .

web:
	npx -y esbuild web/src/app.ts --bundle --minify --outfile=web/dist/app.js

test:
	go test ./...

run: build
	./lexometer
