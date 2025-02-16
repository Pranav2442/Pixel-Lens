import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { Camera, Grid, X, Maximize2, Minimize2, Share2 } from "lucide-react";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const createPersistentImageCache = () => {
  const CACHE_KEY = "pixelLens-imageCache";

  const loadCache = () => {
    try {
      const savedCache = localStorage.getItem(CACHE_KEY);
      return savedCache ? JSON.parse(savedCache) : {};
    } catch (error) {
      console.error("Error loading cache:", error);
      return {};
    }
  };

  const cache = new Map(Object.entries(loadCache()));

  const saveCache = () => {
    try {
      const cacheObject = Object.fromEntries(cache);
      localStorage.setItem(CACHE_KEY, JSON.stringify(cacheObject));
    } catch (error) {
      console.error("Error saving cache:", error);
    }
  };

  return {
    get: (key) => cache.get(key),
    set: (key, value) => {
      cache.set(key, value);
      saveCache();
    },
    has: (key) => cache.has(key),
    clear: () => {
      cache.clear();
      localStorage.removeItem(CACHE_KEY);
    },
  };
};

const imageUrlCache = createPersistentImageCache();
const IMAGE_URL_EXPIRATION = 3600000;

const cleanupCache = () => {
  const now = Date.now();
  Array.from(imageUrlCache.keys()).forEach((key) => {
    const entry = imageUrlCache.get(key);
    if (now - entry.timestamp > IMAGE_URL_EXPIRATION) {
      imageUrlCache.delete(key);
    }
  });
};

const PhotoGallery = () => {
  const [selectedImage, setSelectedImage] = useState(null);
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const lightboxRef = useRef(null);
  const [showFavorites, setShowFavorites] = useState(false);
  const [sharedImageId, setSharedImageId] = useState(null);
  const [loadedImages, setLoadedImages] = useState(new Set());
  const [imageDimensions, setImageDimensions] = useState({});

  const handleImageLoad = useCallback(
    (imageId, naturalWidth, naturalHeight) => {
      if (naturalWidth && naturalHeight) {
        setLoadedImages((prev) => new Set([...prev, imageId]));
        setImageDimensions((prev) => ({
          ...prev,
          [imageId]: {
            width: naturalWidth,
            height: naturalHeight,
            aspectRatio: naturalHeight / naturalWidth,
          },
        }));
      }
    },
    []
  );

  useEffect(() => {
    const cleanup = setInterval(cleanupCache, 3600000);
    return () => clearInterval(cleanup);
  }, []);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const imageId = urlParams.get("image");
    if (imageId) {
      setSharedImageId(imageId);
    }
  }, []);

  useEffect(() => {
    if (sharedImageId && images.length > 0) {
      const image = images.find((img) => img.id === sharedImageId);
      if (image) {
        handleImageClick(image);
      }
    }
  }, [sharedImageId, images]);

  const handleShare = async (e, image) => {
    e.stopPropagation();
    const shareUrl = `${window.location.origin}${
      window.location.pathname
    }?image=${encodeURIComponent(image.id)}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: "✨ Found this gem on PixelLens",
          text: "Explore the visual journey at PixelLens",
          url: shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);

        const tooltip = document.createElement("div");
        tooltip.textContent = "Link copied!";
        tooltip.className =
          "fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-white/10 backdrop-blur-sm text-white px-4 py-2 rounded-lg z-50";
        document.body.appendChild(tooltip);
        setTimeout(() => tooltip.remove(), 2000);
      }
    } catch (error) {
      console.error("Error sharing:", error);
    }
  };

  const [favorites, setFavorites] = useState(() => {
    const savedFavorites = localStorage.getItem("pixelLens-favorites");
    return savedFavorites ? JSON.parse(savedFavorites) : [];
  });

  const s3Client = useMemo(
    () =>
      new S3Client({
        region: "auto",
        endpoint: `https://${
          import.meta.env.VITE_ACCOUNT_ID
        }.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: import.meta.env.VITE_ACCESS_KEY_ID,
          secretAccessKey: import.meta.env.VITE_SECRET_ACCESS_KEY,
        },
        forcePathStyle: true,
      }),
    []
  );

  const BUCKET_NAME = import.meta.env.VITE_BUCKET_NAME;

  const getImageUrl = useCallback(
    async (key) => {
      const cachedEntry = imageUrlCache.get(key);
      if (
        cachedEntry &&
        Date.now() - cachedEntry.timestamp < IMAGE_URL_EXPIRATION
      ) {
        return cachedEntry.url;
      }

      try {
        const command = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key,
        });

        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

        imageUrlCache.set(key, {
          url,
          timestamp: Date.now(),
        });

        return url;
      } catch (error) {
        console.error(`Error getting URL for ${key}:`, error);
        return null;
      }
    },
    [s3Client, BUCKET_NAME]
  );

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && selectedImage) {
        handleClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedImage]);

  const loadImagesFromS3 = useCallback(async () => {
    try {
      setLoading(true);

      const command = new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
      });

      const response = await s3Client.send(command);

      if (!response.Contents) {
        setImages([]);
        setLoading(false);
        return;
      }

      const imagePromises = response.Contents.map(async (object) => {
        const url = await getImageUrl(object.Key);
        return url
          ? {
              id: object.Key,
              url: url,
              lastModified: object.LastModified,
            }
          : null;
      });

      const processedImages = await Promise.all(imagePromises);
      const filteredImages = processedImages
        .filter((image) => image !== null)
        .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

      setImages(filteredImages);
      setLoading(false);
    } catch (error) {
      console.error("Error loading images from S3:", error);
      setLoading(false);
    }
  }, [s3Client, BUCKET_NAME, getImageUrl]);

  useEffect(() => {
    loadImagesFromS3();
  }, [loadImagesFromS3]);

  const handleFullscreen = async (e) => {
    e.stopPropagation();
    try {
      if (!isFullscreen) {
        await lightboxRef.current.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (error) {
      console.error("Fullscreen error:", error);
    }
  };

  const handleClose = async () => {
    if (isFullscreen) {
      try {
        await document.exitFullscreen();
      } catch (error) {
        console.error("Error exiting fullscreen:", error);
      }
    }
    setSelectedImage(null);
  };

  const toggleFavorite = (e, imageId) => {
    e.stopPropagation();
    setFavorites((prev) => {
      const newFavorites = prev.includes(imageId)
        ? prev.filter((id) => id !== imageId)
        : [...prev, imageId];

      localStorage.setItem("pixelLens-favorites", JSON.stringify(newFavorites));
      return newFavorites;
    });
  };

  const isFavorite = (imageId) => favorites.includes(imageId);

  const handleImageClick = useCallback(async (image) => {
    try {
      setSelectedImage(image);
      const newUrl = new URL(window.location);
      newUrl.searchParams.set("image", image.id);
      window.history.pushState({}, "", newUrl);
    } catch (error) {
      console.error("Error handling image click:", error);
    }
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-[#1F1F3C] to-[#2D1B3D]">
      <header className="fixed top-0 left-0 right-0 z-40 bg-[#1F1F3C]/80 backdrop-blur-lg border-b border-white/10">
        <div className="w-full  mx-auto px-4 sm:px-6 py-3 sm:py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 sm:space-x-3">
              <div className="bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg p-1.5 sm:p-2">
                <Camera className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
              </div>
              <h1 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-purple-400 via-pink-400 to-purple-400 bg-clip-text text-transparent">
                Pixel Lens
              </h1>

              <div className="flex items-center space-x-3 ml-3 sm:ml-6">
                <a
                  href="https://github.com/pranav2442"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="w-4 h-4 sm:w-5 sm:h-5"
                    fill="currentColor"
                  >
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                </a>
                <a
                  href="https://instagram.com/pranav.dart"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="w-4 h-4 fill-[#E4405F] opacity-80 hover:opacity-100 transition-opacity sm:w-5 sm:h-5"
                  >
                    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
                  </svg>
                </a>
                <a
                  href="https://www.buymeacoffee.com/pranavcode"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="w-4 h-4 fill-[#FFDD00] opacity-80 hover:opacity-100 transition-opacity sm:w-5 sm:h-5"
                  >
                    <path d="M20.216 6.415l-.132-.666c-.119-.598-.388-1.163-1.001-1.379-.197-.069-.42-.098-.57-.241-.152-.143-.196-.366-.231-.572-.065-.378-.125-.756-.192-1.133-.057-.325-.102-.69-.25-.987-.195-.4-.597-.634-.996-.788a5.723 5.723 0 00-.626-.194c-1-.263-2.05-.36-3.077-.416a25.834 25.834 0 00-3.7.062c-.915.083-1.88.184-2.75.5-.318.116-.646.256-.888.501-.297.302-.393.77-.177 1.146.154.267.415.456.692.58.36.162.737.284 1.123.366 1.075.238 2.189.331 3.287.37 1.218.05 2.437.01 3.65-.118.299-.033.598-.073.896-.119.352-.054.578-.513.474-.834-.124-.383-.457-.531-.834-.473-.466.074-.96.108-1.382.146-1.177.08-2.358.082-3.536.006a22.228 22.228 0 01-1.157-.107c-.086-.01-.18-.025-.258-.036-.243-.036-.484-.08-.724-.13-.111-.027-.111-.185 0-.212h.005c.277-.06.557-.108.838-.147h.002c.131-.009.263-.032.394-.048a25.076 25.076 0 013.426-.12c.674.019 1.347.067 2.017.144l.228.031c.267.04.533.088.798.145.392.085.895.113 1.07.542.055.137.08.288.111.431l.319 1.484a.237.237 0 01-.199.284h-.003c-.037.006-.075.01-.112.015a36.704 36.704 0 01-4.743.295 37.059 37.059 0 01-4.699-.304c-.14-.017-.293-.042-.417-.06-.326-.048-.649-.108-.973-.161-.393-.065-.768-.032-1.123.161-.29.16-.527.404-.675.701-.154.316-.199.66-.267 1-.069.34-.176.707-.135 1.056.087.753.613 1.365 1.37 1.502a39.69 39.69 0 0011.343.376.483.483 0 01.535.53l-.071.697-1.018 9.907c-.041.41-.047.832-.125 1.237-.122.637-.553 1.028-1.182 1.171-.577.131-1.165.2-1.756.205-.656.004-1.31-.025-1.966-.022-.699.004-1.556-.06-2.095-.58-.475-.458-.54-1.174-.605-1.793l-.731-7.013-.322-3.094c-.037-.351-.286-.695-.678-.678-.336.015-.718.3-.678.679l.228 2.185.949 9.112c.147 1.344 1.174 2.068 2.446 2.272.742.12 1.503.144 2.257.156.966.016 1.942.053 2.892-.122 1.408-.258 2.465-1.198 2.616-2.657.34-3.332.683-6.663 1.024-9.995l.215-2.087a.484.484 0 01.39-.426c.402-.078.787-.212 1.074-.518.455-.488.546-1.124.385-1.766zm-1.478.772c-.145.137-.363.201-.578.233-2.416.359-4.866.54-7.308.46-1.748-.06-3.477-.254-5.207-.498-.17-.024-.353-.055-.47-.18-.22-.236-.111-.71-.054-.995.052-.26.152-.609.463-.646.484-.057 1.046.148 1.526.22.577.088 1.156.159 1.737.212 2.48.226 5.002.19 7.472-.14.45-.06.899-.13 1.345-.21.399-.072.84-.206 1.08.206.166.281.188.657.162.974a.544.544 0 01-.169.364zm-6.159 3.9c-.862.37-1.84.788-3.109.788a5.884 5.884 0 01-1.569-.217l.877 9.004c.065.78.717 1.38 1.5 1.38 0 0 1.243.065 1.658.065.447 0 1.786-.065 1.786-.065.783 0 1.434-.6 1.499-1.38l.94-9.95a3.996 3.996 0 00-1.322-.238c-.826 0-1.491.284-2.26.613z" />
                  </svg>
                </a>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              {" "}
              <button
                onClick={() => setShowFavorites(!showFavorites)}
                className={`flex items-center space-x-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg 
                  transition-all duration-300 ease-out transform hover:scale-105 active:scale-95
                  ${
                    showFavorites
                      ? "bg-red-500/20 text-red-500"
                      : "bg-white/5 text-white/70 hover:bg-white/10"
                  }
                  ${
                    favorites.length > 0 ? "ring-2 ring-red-500/20" : ""
                  } // Indication that there are favorites
                `}
                title={`${favorites.length} favorite${
                  favorites.length !== 1 ? "s" : ""
                }`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill={
                    showFavorites || favorites.length > 0
                      ? "currentColor"
                      : "none"
                  }
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`w-4 h-4 ${
                    favorites.length > 0 ? "animate-pulse" : ""
                  }`}
                >
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                </svg>
                <span className="hidden sm:inline">
                  {showFavorites
                    ? "Show All Photos"
                    : `${favorites.length} Favorite${
                        favorites.length !== 1 ? "s" : ""
                      }`}
                </span>

                {favorites.length > 0 && !showFavorites && (
                  <span className="absolute -top-1 -right-1 h-3 w-3 bg-red-500 rounded-full sm:hidden" />
                )}
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="pt-16 sm:pt-20 pb-8 sm:pb-12">
        {loading ? (
          <div className="fixed inset-0 flex flex-col items-center justify-center bg-[#1F1F3C]/50 backdrop-blur-sm z-30">
            <div className="relative">
              <div className="w-16 h-12 sm:w-20 sm:h-16 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg relative animate-pulse">
                <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-8 h-8 sm:w-10 sm:h-10 bg-gray-800 rounded-full">
                  <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-6 h-6 sm:w-8 sm:h-8 bg-gray-700 rounded-full animate-spin">
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-4 h-4 sm:w-6 sm:h-6 bg-gray-600 rounded-full">
                      <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-2 h-2 sm:w-3 sm:h-3 bg-purple-500 rounded-full animate-ping"></div>
                    </div>
                  </div>
                </div>

                <div className="absolute -top-1 right-2 w-3 h-3 sm:w-4 sm:h-4 bg-yellow-400 rounded-full animate-pulse"></div>
              </div>

              <div className="absolute left-1/2 transform -translate-x-1/2 mt-6 text-white/70 text-sm sm:text-base font-medium whitespace-nowrap">
                Loading Gallery
                <span className="inline-block animate-bounce">.</span>
                <span
                  className="inline-block animate-bounce"
                  style={{ animationDelay: "0.2s" }}
                >
                  .
                </span>
                <span
                  className="inline-block animate-bounce"
                  style={{ animationDelay: "0.4s" }}
                >
                  .
                </span>
              </div>
            </div>
          </div>
        ) : showFavorites && favorites.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[50vh] text-white/60 transform transition-all duration-300 ease-out">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-16 w-16 mb-4 text-red-500/50 animate-pulse"
            >
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
            <p className="text-lg sm:text-xl mb-2 transition-all duration-300 ease-out">
              No favorite images yet
            </p>
            <p className="text-sm text-white/40 transition-all duration-300 ease-out">
              Click the heart icon on any image to add it to your favorites
            </p>
          </div>
        ) : images.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[50vh] text-white/60">
            <Camera className="h-12 w-12 sm:h-16 sm:w-16 mb-4" />
            <p className="text-lg sm:text-xl">No images found</p>
          </div>
        ) : (
          <div className="px-2">
            <div className="columns-2 md:columns-3 lg:columns-4 xl:columns-5 gap-2 [column-fill:_balance]">
              {images
                .filter(
                  (image) => !showFavorites || favorites.includes(image.id)
                )
                .map((image) => {
                  const isLoaded = loadedImages.has(image.id);
                  const dimensions = imageDimensions[image.id];

                  return (
                    <div
                      key={image.id}
                      className="relative group rounded-lg overflow-hidden 
                     cursor-pointer transition-all duration-300 
                     hover:-translate-y-1 border border-white/5 
                     shadow-lg shadow-purple-900/20 bg-[#1F1F3C]
                     break-inside-avoid mb-2 inline-block w-full"
                      style={{ marginBottom: "4px" }}
                      onClick={() => handleImageClick(image)}
                    >
                      <div
                        className="relative w-full overflow-hidden"
                        style={{
                          paddingBottom: dimensions
                            ? `${(dimensions.height / dimensions.width) * 100}%`
                            : "100%",
                        }}
                      >
                        <img
                          src={image.url}
                          alt="gallery"
                          onLoad={(e) => {
                            handleImageLoad(
                              image.id,
                              e.target.naturalWidth,
                              e.target.naturalHeight
                            );
                          }}
                          className={`absolute top-0 left-0 w-full h-full object-cover
                          transition-opacity duration-500 ease-in-out
                          ${isLoaded ? "opacity-100" : "opacity-0"}`}
                        />

                        {!isLoaded && (
                          <div className="absolute inset-0 bg-[#1F1F3C] animate-pulse">
                            <div className="w-full h-full bg-white/5 rounded-lg" />
                          </div>
                        )}
                      </div>
                      <div className="absolute bottom-2 left-1.5 z-10">
                      <button
                        onClick={(e) => handleShare(e, image)}
                        className="p-1.5 sm:p-2 bg-black/50 hover:bg-black/70 rounded-full 
                        backdrop-blur-sm transition-colors group-hover:bg-black/70"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="text-white sm:w-4 sm:h-4"
                        >
                          <circle cx="18" cy="5" r="3" />
                          <circle cx="6" cy="12" r="3" />
                          <circle cx="18" cy="19" r="3" />
                          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                        </svg>
                      </button>
                    </div>
                    <div className="absolute top-1 right-1 z-10">
                      <button
                        onClick={(e) => toggleFavorite(e, image.id)}
                        className={`p-1.5 sm:p-2 rounded-full backdrop-blur-sm transition-all duration-300 
                    ${
                      isFavorite(image.id)
                        ? "bg-red-500/50 hover:bg-red-500/70"
                        : "bg-black/50 hover:bg-black/70"
                    }`}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={`w-3 h-3 sm:w-4 sm:h-4 ${
                            isFavorite(image.id) ? "text-white" : "text-white"
                          }`}
                        >
                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                      </button>
                      </div>
                      <div>
                        <div
                          className="absolute inset-0 backdrop-blur-[4px] bg-[#1F1F3C]/40
                  opacity-0 group-hover:opacity-100 
                  transition-all duration-300"
                        />
                        <div
                          className="absolute inset-[1px] border-[0.5px] border-white/10
                  opacity-0 group-hover:opacity-100 
                  scale-[1.02] group-hover:scale-100
                  transition-all duration-500"
                        />
                        <div
                          className="absolute inset-0 bg-gradient-to-br 
                  from-purple-500/10 to-pink-500/10
                  opacity-0 group-hover:opacity-100 
                  transition-all duration-500 delay-75"
                        />
                      </div>{" "}
                    </div>
                  );
                })}
            </div>
          </div>
        )}
        <footer className="relative w-full backdrop-blur-sm border-t border-white/10 mt-8">
          <div className="container mx-auto px-4 py-3">
            <p className="text-center text-xs sm:text-sm text-white/70">
              Made with{" "}
              <span className="inline-block animate-pulse text-purple-500">
                ❤️
              </span>{" "}
              by Pranav
            </p>
          </div>
        </footer>
      </main>

      {selectedImage && (
        <div ref={lightboxRef} className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 backdrop-blur-md bg-black/60"
            onClick={handleClose}
          />

          <div className="absolute top-4 sm:top-6 right-4 sm:right-6 flex items-center space-x-3 sm:space-x-4 z-50">
            <button
              onClick={(e) => toggleFavorite(e, selectedImage.id)}
              className={`p-2 sm:p-3 rounded-full transition-all duration-300 
               ${
                 isFavorite(selectedImage.id)
                   ? "bg-red-500/50 hover:bg-red-500/70"
                   : "bg-black/50 hover:bg-black/70"
               }`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill={isFavorite(selectedImage.id) ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5 sm:h-6 sm:w-6 text-white"
              >
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
            </button>

            <button
              onClick={(e) => handleShare(e, selectedImage)}
              className="p-2 sm:p-3 bg-black/50 hover:bg-black/70 rounded-full transition-all duration-300
                backdrop-blur-sm text-white/90 hover:text-white"
              title="Share image"
            >
              <Share2 className="h-5 w-5 sm:h-6 sm:w-6" />
            </button>

            <button
              onClick={handleFullscreen}
              className="p-2 sm:p-3 bg-black/50 rounded-full"
            >
              {isFullscreen ? (
                <Minimize2 className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
              ) : (
                <Maximize2 className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
              )}
            </button>
            <button
              onClick={handleClose}
              className="p-2 sm:p-3 bg-black/50 rounded-full"
            >
              <X className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
            </button>
          </div>

          <div
            className="relative w-full h-full flex items-center justify-center p-4 sm:p-8 z-40"
            onClick={handleClose}
          >
            <img
              src={selectedImage.url}
              alt="enlarged view"
              className={`
                max-h-[90vh] max-w-[90vw] object-contain rounded-lg 
                ${isFullscreen ? "h-screen w-screen rounded-none" : ""}
              `}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default PhotoGallery;
