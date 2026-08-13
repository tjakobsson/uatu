// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "UatuOpenAPISmoke",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "SmokeClient", targets: ["SmokeClient"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.7.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.8.0"),
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
