package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"

	"github.com/joho/godotenv"
)

//go:embed static/*
var staticFS embed.FS

func main() {
	if err := godotenv.Load(); err != nil {
		log.Printf("Загрузка .env: %v (работаем без .env)", err)
	}
	if os.Getenv("OPENAI_API_KEY") == "" {
		log.Printf("Предупреждение: OPENAI_API_KEY не задан, чат с GPT не будет работать")
	}

	// Отдаём статику (фронт) из встроенной папки static
	staticContent, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatal(err)
	}
	http.Handle("/", http.FileServer(http.FS(staticContent)))

	// API для здоровья сервиса
	http.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})

	// Проверка ключа OpenAI
	http.HandleFunc("/api/check-key", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if os.Getenv("OPENAI_API_KEY") == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":    false,
				"error": "OPENAI_API_KEY не задан. Добавьте ключ в .env и перезапустите сервер.",
			})
			return
		}
		reply, err := callOpenAI("Ответь одним словом: ок")
		if err != nil {
			msg := err.Error()
			if e, ok := err.(*openAIError); ok {
				if e.code == 401 {
					msg = "Ключ недействителен или отозван (401)"
				} else if e.code == 429 {
					msg = "Превышена квота / лимит (429). Проверьте баланс на platform.openai.com"
				}
			}
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": msg})
			return
		}
		if reply == "" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "Пустой ответ от OpenAI"})
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "reply": reply})
	})

	// Чат с ChatGPT
	http.HandleFunc("/api/chat", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Message string `json:"message"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Message == "" {
			http.Error(w, `{"error":"message required"}`, http.StatusBadRequest)
			return
		}
		reply, err := callOpenAI(req.Message)
		if err != nil {
			log.Printf("openai: %v", err)
			msg := err.Error()
			if e, ok := err.(*openAIError); ok && e.code == 401 {
				msg = "Неверный или недействительный ключ OpenAI (401). Проверьте OPENAI_API_KEY в .env"
			} else if e, ok := err.(*openAIError); ok && e.code == 429 {
				msg = "Превышена квота или лимит запросов OpenAI (429). Проверьте баланс на platform.openai.com"
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": msg, "reply": ""})
			return
		}
		if reply == "" {
			reply = "Не удалось получить ответ. Проверьте OPENAI_API_KEY в .env и перезапустите сервер."
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"reply": reply})
	})

	// Транскрипция через Wispr (голос → текст)
	http.HandleFunc("/api/transcribe", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Audio string `json:"audio"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Audio == "" {
			http.Error(w, `{"error":"audio (base64) required"}`, http.StatusBadRequest)
			return
		}
		text, err := transcribeWispr(req.Audio)
		if err != nil {
			log.Printf("wispr: %v", err)
			http.Error(w, `{"error":"transcription failed"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"text": text})
	})

	addr := ":8080"
	log.Printf("Сервер запущен на http://localhost%s", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal(err)
	}
}
