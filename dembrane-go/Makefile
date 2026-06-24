DEVICE ?= iPhone 17 Pro
SCHEME   = DembraneGo
PROJECT  = DembraneGo.xcodeproj
XCODEGEN = .tooling/xcodegen
DEST     = platform=iOS Simulator,name=$(DEVICE)
APP_GLOB = ~/Library/Developer/Xcode/DerivedData/DembraneGo-*/Build/Products/Debug-iphonesimulator/DembraneGo.app

.PHONY: gen test-core build test run clean

gen:
	$(XCODEGEN) generate --spec project.yml

test-core:
	cd Packages/DembraneCore && swift test

build: gen
	xcodebuild build -project $(PROJECT) -scheme $(SCHEME) \
	  -destination '$(DEST)' -configuration Debug CODE_SIGNING_ALLOWED=NO

test: gen
	xcodebuild test -project $(PROJECT) -scheme $(SCHEME) \
	  -destination '$(DEST)' -configuration Debug CODE_SIGNING_ALLOWED=NO

run: build
	xcrun simctl boot "$(DEVICE)" 2>/dev/null || true
	xcrun simctl install "$(DEVICE)" $$(find $(APP_GLOB) -maxdepth 0 | head -1)
	xcrun simctl launch --terminate-running-process "$(DEVICE)" com.dembrane.go

clean:
	rm -rf ~/Library/Developer/Xcode/DerivedData/DembraneGo-* Packages/DembraneCore/.build
