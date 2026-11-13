// Regenerate the tiny H.264 fixture on macOS; CI uses embedded bytes instead.
import AVFoundation
import CoreVideo
import Foundation

let url = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.removeItem(at: url)
let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: 32, AVVideoHeightKey: 32,
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 8000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264BaselineAutoLevel],
])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input,
    sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
        kCVPixelBufferWidthKey as String: 32, kCVPixelBufferHeightKey as String: 32])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)
for frame in 0..<40 {
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.001) }
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
    CVPixelBufferLockBaseAddress(buffer!, [])
    let bytes = CVPixelBufferGetBaseAddress(buffer!)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(buffer!)
    for y in 0..<32 { for x in 0..<32 {
        let offset = y * stride + x * 4
        bytes[offset] = 255; bytes[offset + 1] = 40; bytes[offset + 2] = 120; bytes[offset + 3] = 180
    } }
    CVPixelBufferUnlockBaseAddress(buffer!, [])
    adaptor.append(buffer!, withPresentationTime: CMTime(value: Int64(frame), timescale: 10))
}
input.markAsFinished()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
if let error = writer.error { throw error }
print(try Data(contentsOf: url).base64EncodedString())
