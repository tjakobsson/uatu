// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "UatuOpenAPISmoke",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "SmokeClient", targets: ["SmokeClient"]),
    ],
    dependencies: [
        // Pinned exactly so the smoke test exercises one known generator and
        // runtime rather than whatever resolves on the day CI runs.
        .package(url: "https://github.com/apple/swift-openapi-generator", exact: "1.13.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", exact: "1.12.0"),
    ],
    targets: [
        .target(
            name: "SmokeClient",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            ],
            plugins: [
                .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator"),
            ]
        ),
    ]
)
