// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "CatsSttMacos",
  platforms: [
    .macOS(.v10_15),
  ],
  products: [
    .executable(
      name: "cats-stt-macos",
      targets: ["CatsSttMacos"]
    ),
  ],
  targets: [
    .executableTarget(
      name: "CatsSttMacos"
    ),
  ]
)
