import logging

from tqdm import tqdm
from datasets import Dataset, DatasetDict, load_dataset
from ragas.testset import TestsetGenerator
from huggingface_hub import login
from validation_config import (
    HF_TOKEN,
    HF_VALIDATION_DATASET_REPO,
    DATA_GENERATOR_LLM_MODEL_NAME,
    DATA_GENERATOR_LLM_MODEL_APIKEY,
    DATA_GENERATOR_EMBEDDING_API_KEY,
    DATA_GENERATOR_EMBEDDING_ENDPOINT,
    DATA_GENERATOR_LLM_MODEL_ENDPOINT,
    DATA_GENERATOR_EMBEDDING_DEPLOYMENT,
    DATA_GENERATOR_EMBEDDING_API_VERSION,
    DATA_GENERATOR_LLM_MODEL_API_VERSION,
)
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_openai.embeddings import AzureOpenAIEmbeddings
from langchain_openai.chat_models import AzureChatOpenAI

ds = load_dataset("espnet/floras",'monolingual', streaming=True)
train_dataset = ds['train']

count_of_audio = 10
testset_size =  300
val_data_path = '/home/azureuser/cloudfiles/code/Users/arindamroy11235/echo/echo/server/dembrane/audio_lightrag/validation/data'
echo_eval_list = []

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load dataset with streaming
ds = load_dataset("espnet/floras", 'monolingual', streaming=True)
train_dataset = ds['dev']

for example in tqdm(train_dataset): 
    try:
        logger.info(f"Processing file {example['id']}")
        if float(example['score']) <= 1:
            # Get array shape or length before loading into memory
            array_length = len(example['audio']['array'])     
            sampling_rate = example['audio']['sampling_rate']
            audio_length_seconds = array_length / sampling_rate
            
            # Skip very large files early
            if array_length > 10000000:  # Skip files with more than 10M samples
                logger.warning(f"Skipping large file {example['id']}: {array_length} samples")
                continue
                
            if audio_length_seconds < 600:  # Less than 10 mins
                audio_array = example['audio']['array']
                # sf.write(os.path.join(val_data_path, example['audio']['path']), 
                #         audio_array, sampling_rate)
                echo_eval_list.append({
                    'id': example['id'], 
                    'text': example['text'],
                    'language': example['language'],
                    'score': example['score'],
                    'audio_array': audio_array,
                    'sampling_rate': sampling_rate
                })
                
                logger.info(f"Data added {example['id']}: {audio_length_seconds:.2f} seconds\
                            with filename {example['audio']['path']}")
                
        if len(echo_eval_list) >= count_of_audio:
            break
            
    except Exception as e:
        logger.error(f"Error processing {example['id']}: {str(e)}")
        continue


# print(echo_eval_list)
logger.info(f"Successfully processed {len(echo_eval_list)} files")


text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=1200,  # Adjust chunk size as needed
    chunk_overlap=200,  # Adjust overlap as needed
    length_function=len,
    separators=["\n\n", "\n", " ", ""]
)

texts = [x['text'] for x in echo_eval_list]


# Create Langchain documents with metadata
documents = []
for i, text in enumerate(texts):
    # Preserve the original metadata from echo_eval_list
    metadata = {
        'id': echo_eval_list[i]['id'],
        'language': echo_eval_list[i]['language'],
        'score': echo_eval_list[i]['score'],
        'filename':'FLORAS_dataset'
    }
    
    # Split the text into chunks and create documents
    chunks = text_splitter.create_documents(
        texts=[text],
        metadatas=[metadata]
    )
    documents.extend(chunks)


generator_llm = AzureChatOpenAI(
    name=DATA_GENERATOR_LLM_MODEL_NAME,
    api_version=str(DATA_GENERATOR_LLM_MODEL_API_VERSION),
    api_key=str(DATA_GENERATOR_LLM_MODEL_APIKEY), # type: ignore
    azure_endpoint=str(DATA_GENERATOR_LLM_MODEL_ENDPOINT),
    temperature=0.0
)
embeddings = AzureOpenAIEmbeddings(
    model=str(DATA_GENERATOR_EMBEDDING_DEPLOYMENT),
    api_version=str(DATA_GENERATOR_EMBEDDING_API_VERSION),
    api_key=str(DATA_GENERATOR_EMBEDDING_API_KEY), # type: ignore
    azure_endpoint=str(DATA_GENERATOR_EMBEDDING_ENDPOINT),
)


generator = TestsetGenerator.from_langchain(
    llm = generator_llm,
    embedding_model=embeddings
)


testset = generator.generate_with_langchain_docs(documents, 
                                                 testset_size=testset_size,
                                                 )

testset_df = testset.to_pandas()
testset_df['audio_dataset_id'] = ','.join([x['id'] for x in echo_eval_list])

dataset_dict = DatasetDict({
    "train": Dataset.from_pandas(testset_df)
})

login(token=HF_TOKEN)
dataset_dict.push_to_hub(HF_VALIDATION_DATASET_REPO)